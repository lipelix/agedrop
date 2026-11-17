import { spawn } from "node:child_process";
import { constants } from "node:os";
import type { Readable } from "node:stream";
import type { Command } from "../command.js";
import { parse } from "../command.js";
import { CliError, note, type Output, UsageError } from "../context.js";
import { decryptScope } from "../decrypt.js";
import { envValue } from "../dotenv.js";
import { loadIdentity } from "../identity.js";
import { MIN_REDACT_LENGTH, type Pattern, redactionPatterns, Redactor } from "../redact.js";
import { openRepository, scopeOf } from "../repo.js";

const FORWARDED = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export const exec: Command = {
  name: "exec",
  summary: "run a command with a scope's values in its environment",
  help: `usage: agedrop exec <scope> [--redact | --no-redact] [--identity <file>] [--repo <dir>] -- <cmd> [args...]

Decrypts the env-style secrets directly in secrets/<scope>/ and runs <cmd>
with them added to the environment. Writes nothing to disk and exits with
<cmd>'s exit code (128 + the signal's number when a signal ends it). The
identity is --identity, else AGEDROP_IDENTITY, else ~/.config/agedrop/identity.

--redact replaces every value of ${String(MIN_REDACT_LENGTH)} bytes or more in <cmd>'s stdout and
stderr with [REDACTED:<NAME>], also its URL-encoded, JSON-escaped and base64
forms. A scope with redact = true in agedrop.toml always redacts and refuses
--no-redact. Redaction reads <cmd>'s output through pipes, so <cmd> sees no
terminal on stdout and stderr: interactive programs, colours and progress bars
may change. It keeps values out of output, not out of <cmd>'s hands.`,
  async run(ctx, args) {
    const separator = args.indexOf("--");
    if (separator === -1) throw new UsageError("missing -- <cmd>");
    const [cmd, ...cmdArgs] = args.slice(separator + 1);
    if (cmd === undefined) throw new UsageError("missing <cmd> after --");
    const { values, positionals } = parse(args.slice(0, separator), {
      identity: { type: "string" },
      repo: { type: "string" },
      redact: { type: "boolean", default: false },
      "no-redact": { type: "boolean", default: false },
    });
    const [scope, ...rest] = positionals;
    if (scope === undefined) throw new UsageError("missing <scope>");
    if (rest.length > 0) throw new UsageError(`unexpected argument "${rest[0] ?? ""}" before --`);
    if (values.redact && values["no-redact"]) {
      throw new UsageError("--redact and --no-redact exclude each other");
    }

    const repo = await openRepository(ctx, values.repo);
    scopeOf(repo, scope); // an unknown scope is reported before a missing identity
    if (values["no-redact"] && repo.config.redacted.has(scope)) {
      throw new CliError(
        `scope "${scope}" has redact = true in agedrop.toml, so --no-redact is refused`,
      );
    }
    const redact = values.redact || repo.config.redacted.has(scope);
    const identity = await loadIdentity(ctx, values.identity);
    const secrets = await decryptScope(repo, scope, [], identity);

    const env: Record<string, string | undefined> = { ...ctx.env };
    const skipped: string[] = [];
    const short: string[] = [];
    const patterns: Pattern[] = [];
    for (const secret of secrets) {
      const value = secret.kind === "env" ? envValue(secret.value) : undefined;
      if (value === undefined) {
        skipped.push(secret.name);
        continue;
      }
      env[secret.name] = value;
      if (!redact) continue;
      if (secret.value.length < MIN_REDACT_LENGTH) short.push(secret.name);
      else patterns.push(...redactionPatterns(secret.name, secret.value));
    }
    if (skipped.length > 0) {
      note(
        ctx,
        `agedrop: skipped secrets that cannot be environment variables: ${skipped.join(", ")}`,
      );
    }
    if (short.length > 0) {
      note(
        ctx,
        `agedrop: not redacted, shorter than ${String(MIN_REDACT_LENGTH)} bytes: ${short.join(", ")}`,
      );
    }
    return run(cmd, cmdArgs, env, ctx.cwd, redact ? { patterns, ctx } : undefined);
  },
};

interface Redaction {
  readonly patterns: readonly Pattern[];
  readonly ctx: { readonly stdout: Output; readonly stderr: Output };
}

function run(
  cmd: string,
  args: string[],
  env: Record<string, string | undefined>,
  cwd: string,
  redaction: Redaction | undefined,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env,
      stdio: redaction === undefined ? "inherit" : ["inherit", "pipe", "pipe"],
    });
    if (redaction !== undefined) {
      // Both are pipes here, so set; null only with inherited stdio.
      if (child.stdout !== null) relay(child.stdout, redaction.ctx.stdout, redaction.patterns);
      if (child.stderr !== null) relay(child.stderr, redaction.ctx.stderr, redaction.patterns);
    }
    const forward = (signal: NodeJS.Signals): void => {
      child.kill(signal);
    };
    for (const signal of FORWARDED) process.on(signal, forward);
    const cleanup = (): void => {
      for (const signal of FORWARDED) process.off(signal, forward);
    };
    child.on("error", (error: NodeJS.ErrnoException) => {
      cleanup();
      reject(
        error.code === "ENOENT"
          ? new CliError(`cannot run "${cmd}": command not found`, 127)
          : new CliError(`cannot run "${cmd}": ${error.message}`, 126),
      );
    });
    // "close" comes after the child exited and its pipes ended, so all redacted output is written.
    child.on("close", (code, signal) => {
      cleanup();
      resolve(code ?? 128 + (signal === null ? 0 : constants.signals[signal]));
    });
  });
}

/**
 * Passes a child's output stream to `out` through a {@link Redactor}, keeping `out`'s backpressure. When
 * `out` fails (its reader went away), the child's pipe is closed too, so the child sees the broken pipe
 * as it would without redaction.
 */
function relay(source: Readable, out: Output, patterns: readonly Pattern[]): void {
  const redactor = new Redactor(patterns);
  let broken = false;
  out.on?.("error", () => {
    broken = true;
    source.destroy();
  });
  const write = (bytes: Buffer): void => {
    if (bytes.length === 0 || broken) return;
    if (out.write(bytes) === false && out.once !== undefined) {
      source.pause();
      out.once("drain", () => source.resume());
    }
  };
  source.on("data", (chunk: Buffer) => {
    write(redactor.write(chunk));
  });
  source.on("end", () => {
    write(redactor.end());
  });
}

import { spawn } from "node:child_process";
import { constants } from "node:os";
import type { Command } from "../command.js";
import { parse } from "../command.js";
import { CliError, note, UsageError } from "../context.js";
import { decryptScope } from "../decrypt.js";
import { envValue } from "../dotenv.js";
import { loadIdentity } from "../identity.js";
import { openRepository, scopeOf } from "../repo.js";

const FORWARDED = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export const exec: Command = {
  name: "exec",
  summary: "run a command with a scope's values in its environment",
  help: `usage: agedrop exec <scope> [--identity <file>] [--repo <dir>] -- <cmd> [args...]

Decrypts the env-style secrets directly in secrets/<scope>/ and runs <cmd>
with them added to the environment. Writes nothing to disk and exits with
<cmd>'s exit code. The identity is --identity, else AGEDROP_IDENTITY, else
~/.config/agedrop/identity.`,
  async run(ctx, args) {
    const separator = args.indexOf("--");
    if (separator === -1) throw new UsageError("missing -- <cmd>");
    const [cmd, ...cmdArgs] = args.slice(separator + 1);
    if (cmd === undefined) throw new UsageError("missing <cmd> after --");
    const { values, positionals } = parse(args.slice(0, separator), {
      identity: { type: "string" },
      repo: { type: "string" },
    });
    const [scope, ...rest] = positionals;
    if (scope === undefined) throw new UsageError("missing <scope>");
    if (rest.length > 0) throw new UsageError(`unexpected argument "${rest[0] ?? ""}" before --`);

    const repo = await openRepository(ctx, values.repo);
    scopeOf(repo, scope); // an unknown scope is reported before a missing identity
    const identity = await loadIdentity(ctx, values.identity);
    const secrets = await decryptScope(repo, scope, [], identity);

    const env: Record<string, string | undefined> = { ...ctx.env };
    const skipped: string[] = [];
    for (const secret of secrets) {
      const value = secret.kind === "env" ? envValue(secret.value) : undefined;
      if (value === undefined) skipped.push(secret.name);
      else env[secret.name] = value;
    }
    if (skipped.length > 0) {
      note(
        ctx,
        `agedrop: skipped secrets that cannot be environment variables: ${skipped.join(", ")}`,
      );
    }
    return run(cmd, cmdArgs, env, ctx.cwd);
  },
};

function run(
  cmd: string,
  args: string[],
  env: Record<string, string | undefined>,
  cwd: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: "inherit" });
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
    child.on("exit", (code, signal) => {
      cleanup();
      resolve(code ?? 128 + (signal === null ? 0 : constants.signals[signal]));
    });
  });
}

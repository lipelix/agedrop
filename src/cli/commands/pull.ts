import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { secretPath } from "../../names.js";
import { writeFileAtomic } from "../../node.js";
import type { Command } from "../command.js";
import { parse } from "../command.js";
import { CliError, note, UsageError } from "../context.js";
import { decryptScope } from "../decrypt.js";
import { envLine, envValue } from "../dotenv.js";
import { loadIdentity } from "../identity.js";
import { openRepository, scopeOf } from "../repo.js";

export const pull: Command = {
  name: "pull",
  summary: "decrypt a scope to files or an env file (needs the host identity)",
  help: `usage: agedrop pull <scope> [NAME...] (--to <dir>|- | --env <file>|-)
                    [--identity <file>] [--repo <dir>]

Decrypts the secrets directly in secrets/<scope>/ (or only NAME...):
  --to <dir>    one file per secret, <dir>/<NAME>, mode 600
  --to -        print one value to stdout
  --env <file>  NAME=value lines for env-style secrets, mode 600
  --env -       print those lines to stdout
The identity is --identity, else AGEDROP_IDENTITY, else ~/.config/agedrop/identity.`,
  async run(ctx, args) {
    const { values, positionals } = parse(args, {
      to: { type: "string" },
      env: { type: "string" },
      identity: { type: "string" },
      repo: { type: "string" },
    });
    const [scope, ...names] = positionals;
    if (scope === undefined) throw new UsageError("missing <scope>");
    if ((values.to === undefined) === (values.env === undefined)) {
      throw new UsageError("pass exactly one of --to <dir> and --env <file>");
    }
    const repo = await openRepository(ctx, values.repo);
    scopeOf(repo, scope); // an unknown scope is reported before a missing identity
    const identity = await loadIdentity(ctx, values.identity);
    const secrets = await decryptScope(repo, scope, names, identity);

    if (values.to === "-") {
      const [only, ...more] = secrets;
      if (only === undefined || more.length > 0) {
        throw new CliError(
          `--to - prints one value, and ${String(secrets.length)} secrets match; name one: agedrop pull ${scope} <NAME> --to -`,
        );
      }
      ctx.stdout.write(only.value);
      return 0;
    }

    if (values.to !== undefined) {
      const dir = resolve(ctx.cwd, values.to);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      for (const secret of secrets) {
        await writeFileAtomic(join(dir, secret.name), secret.value, { mode: 0o600 });
      }
      note(
        ctx,
        `wrote ${String(secrets.length)} secret${secrets.length === 1 ? "" : "s"} to ${dir}`,
      );
      return 0;
    }

    let text = "";
    const skipped: string[] = [];
    for (const secret of secrets) {
      if (secret.kind !== "env") {
        skipped.push(secret.name);
        continue;
      }
      const value = envValue(secret.value);
      if (value === undefined) {
        throw new CliError(
          `${secretPath(scope, secret.name)}: not UTF-8 text without NUL bytes, so it cannot go in an env file`,
        );
      }
      text += envLine(secret.name, value);
    }
    if (skipped.length > 0) {
      note(ctx, `skipped file-style secrets (use --to <dir>): ${skipped.join(", ")}`);
    }
    if (values.env === "-") {
      ctx.stdout.write(text);
      return 0;
    }
    const file = resolve(ctx.cwd, values.env ?? "");
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFileAtomic(file, text, { mode: 0o600 });
    const count = secrets.length - skipped.length;
    note(ctx, `wrote ${String(count)} variable${count === 1 ? "" : "s"} to ${file}`);
    return 0;
  },
};

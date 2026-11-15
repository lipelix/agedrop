import { secretKind, secretPath } from "../../names.js";
import type { Command } from "../command.js";
import { parse } from "../command.js";
import { note, UsageError } from "../context.js";
import { openRepository, scopeOf } from "../repo.js";
import { checkValue, readValue, storeSecret } from "../store.js";

export const add: Command = {
  name: "add",
  summary: "encrypt a value from stdin to a scope's recipients",
  help: `usage: agedrop add <scope> <NAME> [--repo <dir>] < value

Reads the value from stdin (exact bytes; from a terminal, one hidden line)
and writes secrets/<scope>/<NAME>.age, encrypted to the scope's recipients
with public keys only. Records the recipient set in agedrop.lock.
NAME is FOO_BAR for env-style values or foo.bar for file-style ones.`,
  async run(ctx, args) {
    const { values, positionals } = parse(args, { repo: { type: "string" } });
    const [scope, name, ...rest] = positionals;
    if (scope === undefined || name === undefined) throw new UsageError("missing <scope> <NAME>");
    if (rest.length > 0) {
      throw new UsageError(`unexpected argument: values are read from stdin, never from arguments`);
    }
    const kind = secretKind(name);
    if (kind === undefined) {
      throw new UsageError(
        `invalid secret name "${name}": use FOO_BAR for env-style values or foo.bar for file-style ones`,
      );
    }
    const repo = await openRepository(ctx, values.repo);
    const resolved = scopeOf(repo, scope);

    const value = await readValue(ctx, `value for ${scope}/${name}: `);
    checkValue(ctx, name, kind, value);
    const replaced = await storeSecret(repo, resolved, name, value);

    note(
      ctx,
      `${replaced ? "replaced" : "added"} ${secretPath(scope, name)} for ${resolved.names.join(", ")}`,
    );
    return 0;
  },
};

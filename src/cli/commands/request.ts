import { mkdir } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { secretKind } from "../../names.js";
import { loadRequests, writeFileAtomic } from "../../node.js";
import { formatRequest, newRequestId, requestPath } from "../../requests.js";
import type { Command } from "../command.js";
import { parse } from "../command.js";
import { type Context, note, UsageError } from "../context.js";
import { openRepository, scopeOf } from "../repo.js";

export const REQUESTER_ENV = "AGEDROP_REQUESTED_BY";

export const request: Command = {
  name: "request",
  summary: "ask a human for a secret (safe for agents: no value, no key)",
  help: `usage: agedrop request <scope> <NAME> --reason <text> [--by <who>]
                       [--generate <cmd>] [--repo <dir>]

Writes requests/<id>.toml and prints <id>. The request holds no value, so
an agent can run this. A human runs agedrop fulfil <id>; the requester never
sees the value. Commit and push the request file yourself.
  --by <who>        requested_by (default: $AGEDROP_REQUESTED_BY, else user@host)
  --generate <cmd>  a hint: a shell command that makes a suitable value
When a request for the same secret is open already, prints its id instead.`,
  async run(ctx, args) {
    const { values, positionals } = parse(args, {
      reason: { type: "string" },
      by: { type: "string" },
      generate: { type: "string" },
      repo: { type: "string" },
    });
    const [scope, name, ...rest] = positionals;
    if (scope === undefined || name === undefined) throw new UsageError("missing <scope> <NAME>");
    if (rest.length > 0) {
      throw new UsageError(`unexpected argument "${rest[0] ?? ""}": a request carries no value`);
    }
    if (secretKind(name) === undefined) {
      throw new UsageError(
        `invalid secret name "${name}": use FOO_BAR for env-style values or foo.bar for file-style ones`,
      );
    }
    const reason = values.reason?.trim();
    if (reason === undefined || reason === "") {
      throw new UsageError("missing --reason: say what the secret is for");
    }
    const generate = values.generate?.trim();
    if (generate === "") throw new UsageError("--generate needs a command");
    const by = values.by?.trim() ?? defaultRequester(ctx);
    if (by === "") throw new UsageError("--by needs a name");

    const repo = await openRepository(ctx, values.repo);
    scopeOf(repo, scope);

    const open = (await loadRequests(repo.root)).find((r) => r.scope === scope && r.name === name);
    if (open !== undefined) {
      note(ctx, `${scope}/${name} is already requested: ${requestPath(open.id)}`);
      ctx.stdout.write(`${open.id}\n`);
      return 0;
    }

    const id = newRequestId();
    const text = formatRequest({
      id,
      scope,
      name,
      reason,
      requestedBy: by,
      created: new Date().toISOString(),
      ...(generate === undefined ? {} : { generate }),
    });
    const path = join(repo.root, requestPath(id));
    await mkdir(dirname(path), { recursive: true });
    await writeFileAtomic(path, text, { mode: 0o644, exclusive: true });
    note(ctx, `wrote ${requestPath(id)}: commit and push it, then wait for agedrop fulfil ${id}`);
    ctx.stdout.write(`${id}\n`);
    return 0;
  },
};

function defaultRequester(ctx: Context): string {
  const fromEnv = ctx.env[REQUESTER_ENV]?.trim();
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return `${userInfo().username}@${hostname()}`;
}

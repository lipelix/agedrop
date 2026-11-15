import { loadRequests } from "../../node.js";
import type { Command } from "../command.js";
import { parse } from "../command.js";
import { note, UsageError } from "../context.js";
import { openRepository, scopeFilter } from "../repo.js";
import { requestTable } from "../table.js";

export const requests: Command = {
  name: "requests",
  summary: "list open requests for secrets",
  help: `usage: agedrop requests [scope] [--json] [--repo <dir>]

Lists the open requests in requests/ (in scope and the scopes nested in it,
or all). Fulfil one with agedrop fulfil <id>. --json includes generate hints.`,
  async run(ctx, args) {
    const { values, positionals } = parse(args, {
      json: { type: "boolean", default: false },
      repo: { type: "string" },
    });
    const [scope, ...rest] = positionals;
    if (rest.length > 0) throw new UsageError(`unexpected argument "${rest[0] ?? ""}"`);
    const repo = await openRepository(ctx, values.repo);
    const inScope = scopeFilter(repo, scope);
    const open = (await loadRequests(repo.root)).filter((r) => inScope(r.scope));
    if (values.json) {
      ctx.stdout.write(`${JSON.stringify(open, null, 2)}\n`);
      return 0;
    }
    if (open.length === 0) {
      note(ctx, scope === undefined ? "no open requests" : `no open requests in ${scope}`);
      return 0;
    }
    ctx.stdout.write(requestTable(open));
    return 0;
  },
};

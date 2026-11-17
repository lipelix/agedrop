import { recipientSetFingerprint } from "../../lock.js";
import { SECRETS_DIR } from "../../names.js";
import { listSecretFiles, loadRequests, readLock } from "../../node.js";
import { resolveScope } from "../../scope.js";
import type { Command } from "../command.js";
import { parse } from "../command.js";
import { note, UsageError } from "../context.js";
import { gitInfo } from "../git.js";
import { tooShortToRedact, tooShortWarning } from "../redact.js";
import { openRepository, scopeFilter } from "../repo.js";
import { requestTable, table } from "../table.js";

type Status = "ok" | "stale" | "unknown scope";

interface Row {
  readonly secret: string;
  readonly scope: string;
  readonly name: string;
  readonly status: Status;
  readonly changed: string | null;
  readonly author: string | null;
  readonly uncommitted: boolean;
}

export const ls: Command = {
  name: "ls",
  summary: "list secrets, last change, stale encryption and open requests",
  help: `usage: agedrop ls [scope] [--json] [--repo <dir>]

Lists secrets (in scope and the scopes nested in it, or all), when and by
whom each was last committed, and its status: ok, stale (encrypted to an
older recipient set; needs rekey) or unknown scope. Then open requests.
Warns on stderr about env-style secrets too short for redaction in scopes
with redact = true. Never decrypts anything.`,
  async run(ctx, args) {
    const { values, positionals } = parse(args, {
      json: { type: "boolean", default: false },
      repo: { type: "string" },
    });
    const [scope, ...rest] = positionals;
    if (rest.length > 0) throw new UsageError(`unexpected argument "${rest[0] ?? ""}"`);
    const repo = await openRepository(ctx, values.repo);
    const inScope = scopeFilter(repo, scope);

    const lock = await readLock(repo.root);
    const fingerprints = new Map<string, string>();
    for (const s of repo.config.scopes.keys()) {
      const resolved = resolveScope(repo.config, repo.recipients, s);
      fingerprints.set(s, await recipientSetFingerprint(resolved.recipients));
    }
    const git = await gitInfo(repo.root, SECRETS_DIR);

    const rows: Row[] = [];
    const files = (await listSecretFiles(repo.root)).filter(
      (file) => file.scope !== undefined && inScope(file.scope),
    );
    for (const file of files) {
      if (file.scope === undefined || file.name === undefined) continue;
      const id = `${file.scope}/${file.name}`;
      const expected = fingerprints.get(file.scope);
      const status: Status =
        expected === undefined
          ? "unknown scope"
          : lock.secrets.get(id) === expected
            ? "ok"
            : "stale";
      const change = git?.changes.get(file.path);
      rows.push({
        secret: id,
        scope: file.scope,
        name: file.name,
        status,
        changed: change?.date ?? null,
        author: change?.author ?? null,
        uncommitted: git?.dirty.has(file.path) ?? false,
      });
    }
    const requests = (await loadRequests(repo.root)).filter((r) => inScope(r.scope));
    for (const path of await tooShortToRedact(repo.root, repo.config.redacted, files)) {
      note(ctx, tooShortWarning(path));
    }

    if (values.json) {
      ctx.stdout.write(`${JSON.stringify({ secrets: rows, requests }, null, 2)}\n`);
      return 0;
    }
    if (rows.length === 0) note(ctx, scope === undefined ? "no secrets" : `no secrets in ${scope}`);
    else {
      ctx.stdout.write(
        table(
          ["SECRET", "STATUS", "CHANGED", "BY"],
          rows.map((row) => [
            row.secret,
            row.status,
            row.uncommitted ? "uncommitted" : (row.changed?.slice(0, 10) ?? "-"),
            row.uncommitted ? "" : (row.author ?? "-"),
          ]),
        ),
      );
    }
    if (requests.length > 0) {
      ctx.stdout.write(`\n${requestTable(requests)}`);
    }
    return 0;
  },
};

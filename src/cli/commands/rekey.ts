import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { OWNERS_GROUP } from "../../config.js";
import { type Lock, lockSecret, recipientSetFingerprint } from "../../lock.js";
import { secretId, secretPath } from "../../names.js";
import { listSecretFiles, readLock, writeFileAtomic } from "../../node.js";
import { resolveScope, type ResolvedScope } from "../../scope.js";
import { decryptSecret, encryptSecret } from "../../secret.js";
import type { Command } from "../command.js";
import { parse } from "../command.js";
import { CliError, note, UsageError } from "../context.js";
import { loadIdentity, publicKeys } from "../identity.js";
import { openRepository, scopeFilter } from "../repo.js";
import { writeLock } from "../store.js";

export const rekey: Command = {
  name: "rekey",
  summary: "re-encrypt stale secrets to the current recipients (owner identity)",
  help: `usage: agedrop rekey [scope] [--all] [--identity <file>] [--repo <dir>]

Re-encrypts the stale secrets (in scope and the scopes nested in it, or all)
to their scope's current recipients and updates agedrop.lock. --all
re-encrypts every secret. Needs an owner identity: --identity, else
AGEDROP_IDENTITY, else ~/.config/agedrop/identity.

Then prints "rotate <secret>: …" for each secret a removed or replaced key
could read: old commits stay decryptable by that key, so change the value at
its source and agedrop add it again. Does not commit.`,
  async run(ctx, args) {
    const { values, positionals } = parse(args, {
      all: { type: "boolean", default: false },
      identity: { type: "string" },
      repo: { type: "string" },
    });
    const [scope, ...rest] = positionals;
    if (rest.length > 0) throw new UsageError(`unexpected argument "${rest[0] ?? ""}"`);
    const repo = await openRepository(ctx, values.repo);
    const inScope = scopeFilter(repo, scope);

    const resolved = new Map<string, { scope: ResolvedScope; fingerprint: string }>();
    for (const s of repo.config.scopes.keys()) {
      if (!inScope(s)) continue;
      const r = resolveScope(repo.config, repo.recipients, s);
      resolved.set(s, { scope: r, fingerprint: await recipientSetFingerprint(r.recipients) });
    }

    const oldLock = await readLock(repo.root);
    const todo: { id: string; name: string; target: ResolvedScope }[] = [];
    for (const file of await listSecretFiles(repo.root)) {
      if (file.scope === undefined || file.name === undefined) continue;
      const target = resolved.get(file.scope);
      if (target === undefined) continue; // outside the filter, or a scope agedrop.toml lacks
      const id = secretId(file.scope, file.name);
      if (values.all || oldLock.secrets.get(id) !== target.fingerprint) {
        todo.push({ id, name: file.name, target: target.scope });
      }
    }
    if (todo.length === 0) {
      note(
        ctx,
        `nothing to rekey: every secret${scope === undefined ? "" : ` in ${scope}`} is up to date`,
      );
      return 0;
    }

    const identity = await loadIdentity(ctx, values.identity);
    const mine = new Set(await publicKeys(identity));
    const owners = repo.config.groups.get(OWNERS_GROUP) ?? [];
    const ownerKeys = owners.map((name) => repo.recipients.get(name)?.recipient);
    if (!ownerKeys.some((key) => key !== undefined && mine.has(key))) {
      throw new CliError(
        `rekey needs an owner identity: the identity from ${identity.source} is not in the ${OWNERS_GROUP} group (${owners.join(", ")})`,
      );
    }

    let lock: Lock = oldLock;
    const rotate: string[] = [];
    let failed = 0;
    for (const { id, name, target } of todo) {
      const path = secretPath(target.scope, name);
      let value: Uint8Array;
      try {
        value = await decryptSecret(
          await readFile(join(repo.root, path), "utf8"),
          identity.identities,
        );
      } catch (error) {
        ctx.stderr.write(
          `agedrop: ${path}: cannot decrypt with the owner identity, skipped: ${(error as Error).message}\n`,
        );
        failed++;
        continue;
      }
      await writeFileAtomic(join(repo.root, path), await encryptSecret(value, target.recipients), {
        mode: 0o644,
      });
      lock = await lockSecret(lock, id, target);
      const reason = rotationReason(oldLock, id, target);
      if (reason !== undefined) rotate.push(`rotate ${id}: ${reason}\n`);
    }
    await writeLock(repo, lock);

    const done = todo.length - failed;
    note(
      ctx,
      `rekeyed ${String(done)} secret${done === 1 ? "" : "s"}; review with git diff and commit`,
    );
    for (const line of rotate) ctx.stdout.write(line);
    if (rotate.length > 0) {
      note(
        ctx,
        `${String(rotate.length)} secret${rotate.length === 1 ? "" : "s"} to rotate: old commits stay decryptable by the removed keys, so change each value at its source and agedrop add it again`,
      );
    }
    return failed > 0 ? 1 : 0;
  },
};

/**
 * Why a secret must be rotated after rekeying it to `target`, or `undefined` when every key that
 * could read it before can read it now.
 */
function rotationReason(lock: Lock, id: string, target: ResolvedScope): string | undefined {
  const fingerprint = lock.secrets.get(id);
  if (fingerprint === undefined) return "previous recipients unknown (no agedrop.lock entry)";
  const before = lock.sets.get(fingerprint);
  if (before === undefined) return "previous recipients unknown (no [sets] entry in agedrop.lock)";
  const now = new Set(target.recipients);
  const lost = [...before].filter(([, key]) => !now.has(key));
  if (lost.length === 0) return undefined;
  return `no longer for ${lost.map(([name, key]) => `${name} (${key})`).join(", ")}`;
}

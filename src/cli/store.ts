import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { formatLock, type Lock, lockSecret } from "../lock.js";
import { LOCK_FILE, type SecretKind, secretId, secretPath } from "../names.js";
import { readLock, type Repository, writeFileAtomic } from "../node.js";
import type { ResolvedScope } from "../scope.js";
import { encryptSecret } from "../secret.js";
import { CliError, type Context, note } from "./context.js";
import { envValue } from "./dotenv.js";
import { readAll, readHiddenLine } from "./input.js";
import { exists } from "./repo.js";

/** Reads a value from stdin as exact bytes; from a terminal, one hidden line. */
export async function readValue(ctx: Context, prompt: string): Promise<Uint8Array> {
  return ctx.stdin.isTTY
    ? new TextEncoder().encode(await readHiddenLine(ctx, prompt))
    : readAll(ctx.stdin);
}

/**
 * Checks a value before it is stored: not empty, and for env-style names UTF-8 without NUL bytes.
 * Warns about a trailing newline, which is kept.
 */
export function checkValue(ctx: Context, name: string, kind: SecretKind, value: Uint8Array): void {
  if (value.length === 0) throw new CliError("empty value: nothing to add");
  if (kind !== "env") return;
  if (envValue(value) === undefined) {
    throw new CliError(
      `${name} is env-style, so its value must be UTF-8 text without NUL bytes; use a lowercase file-style name for binary values`,
    );
  }
  if (value[value.length - 1] === 0x0a) {
    note(
      ctx,
      `agedrop: warning: the value ends with a newline, which is kept (use printf, not echo)`,
    );
  }
}

/**
 * Encrypts `value` to the scope's recipients, writes `secrets/<scope>/<NAME>.age` and records the
 * recipient set in `agedrop.lock`. Returns whether a secret was replaced.
 */
export async function storeSecret(
  repo: Repository,
  scope: ResolvedScope,
  name: string,
  value: Uint8Array,
): Promise<boolean> {
  const path = join(repo.root, secretPath(scope.scope, name));
  const replaced = await exists(path);
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, await encryptSecret(value, scope.recipients), { mode: 0o644 });
  const lock = await lockSecret(await readLock(repo.root), secretId(scope.scope, name), scope);
  await writeLock(repo, lock);
  return replaced;
}

export async function writeLock(repo: Repository, lock: Lock): Promise<void> {
  await writeFileAtomic(join(repo.root, LOCK_FILE), formatLock(lock), { mode: 0o644 });
}

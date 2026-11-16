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

/** Removes trailing newlines (`\n`, `\r\n`), as shell `$(…)` does. */
export function trimNewlines(value: Uint8Array): Uint8Array {
  let end = value.length;
  while (end > 0 && (value[end - 1] === 0x0a || value[end - 1] === 0x0d)) end--;
  return value.subarray(0, end);
}

/**
 * Prepares a value before it is stored. An env-style value loses its trailing newlines, as with `$(…)`,
 * since `echo` and files add one that no environment variable wants; it must then be UTF-8 without NUL
 * bytes. A file-style value keeps its exact bytes. An empty value is an error.
 */
export function prepareValue(
  ctx: Context,
  name: string,
  kind: SecretKind,
  input: Uint8Array,
): Uint8Array {
  const value = kind === "env" ? trimNewlines(input) : input;
  if (value.length === 0) throw new CliError("empty value: nothing to add");
  if (kind !== "env") return value;
  if (envValue(value) === undefined) {
    throw new CliError(
      `${name} is env-style, so its value must be UTF-8 text without NUL bytes; use a lowercase file-style name for binary values`,
    );
  }
  if (value.length !== input.length) {
    note(ctx, `agedrop: removed the trailing newline from ${name}, as $(…) does`);
  }
  return value;
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

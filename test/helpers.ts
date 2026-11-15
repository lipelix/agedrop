import { bech32 } from "@scure/base";
import { execFile } from "node:child_process";
import { createECDH, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { promisify } from "node:util";
import { generateX25519Identity, identityToRecipient } from "age-encryption";

export const run = promisify(execFile);

/**
 * Writes `input` to a child's stdin and closes it. A child that exits before reading all of its
 * stdin (age with no matching identity, a CLI usage error) makes the write fail with EPIPE. That
 * is expected, the exit code reports the failure, so EPIPE is ignored instead of becoming an
 * unhandled error. Any other stdin error goes to `onError`.
 */
export function endStdin(
  stdin: Writable | null,
  input: Uint8Array | string,
  onError: (error: Error) => void,
): void {
  if (stdin === null) return;
  stdin.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") onError(error);
  });
  stdin.end(input);
}

/** A fresh throwaway key pair. Never commit real keys, including in tests. */
export async function throwawayKey(): Promise<{ identity: string; recipient: string }> {
  const identity = await generateX25519Identity();
  return { identity, recipient: await identityToRecipient(identity) };
}

/**
 * Throwaway tag recipients that typage accepts: `age1tag1…` (a P-256 point) and `age1tagpq1…`
 * (ML-KEM-768 key bytes, random here because typage checks only their length, plus a P-256 point).
 */
export function throwawayTagRecipients(): { tag: string; tagpq: string } {
  const p256 = createECDH("prime256v1");
  p256.generateKeys();
  const tag = bech32.encodeFromBytes("age1tag", p256.getPublicKey(null, "compressed"));
  const pq = new Uint8Array([...randomBytes(1184), ...p256.getPublicKey(null, "uncompressed")]);
  const tagpq = bech32.encode("age1tagpq", bech32.toWords(pq), false);
  return { tag, tagpq };
}

export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "agedrop-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Decrypts an armored secret with the stock `age` CLI (AGE_BIN, else `age` on PATH), as a host would. */
export async function ageDecrypt(armored: string, identity: string): Promise<string> {
  return withTempDir(async (dir) => {
    const keyFile = join(dir, "identity");
    const secretFile = join(dir, "SECRET.age");
    await writeFile(keyFile, `${identity}\n`, { mode: 0o600 });
    await writeFile(secretFile, armored);
    const { stdout } = await run(process.env.AGE_BIN ?? "age", ["-d", "-i", keyFile, secretFile]);
    return stdout;
  });
}

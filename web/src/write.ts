/**
 * Turns a value into one commit (SPEC.md § Web UI, Writes): the secret encrypted to its scope's current
 * recipients, the updated `agedrop.lock`, and for a fulfilled request the deleted request file.
 */
import {
  encryptSecret,
  formatLock,
  LOCK_FILE,
  lockSecret,
  requestPath,
  secretId,
  secretKind,
  secretPath,
} from "../../src/index.js";
import { GitHubError, type CommitInput, type GitHubClient } from "./github.js";
import { loadSnapshot, type Snapshot } from "./snapshot.js";

/** Largest value the page accepts: armored age stays well under GitHub's API limits. */
export const MAX_VALUE_BYTES = 1024 * 1024;

export interface WriteRequest {
  readonly scope: string;
  readonly name: string;
  readonly value: Uint8Array;
  /** The request this write fulfils. */
  readonly requestId?: string;
}

export class WriteError extends Error {
  override readonly name = "WriteError";
}

/** Why a value cannot be stored, or `undefined` when it can. */
export function valueProblem(name: string, value: Uint8Array): string | undefined {
  if (value.length === 0) return "the value is empty";
  if (value.length > MAX_VALUE_BYTES) return "the value is larger than 1 MiB";
  if (secretKind(name) === "env") {
    if (value.includes(0)) return `${name} is env-style, so its value cannot hold a NUL byte`;
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(value);
    } catch {
      return `${name} is env-style, so its value must be UTF-8 text`;
    }
  }
  return undefined;
}

/** Builds the commit for `write` against `snapshot`. Encrypts; sends nothing. */
export async function prepareWrite(snapshot: Snapshot, write: WriteRequest): Promise<CommitInput> {
  const blocking = snapshot.problems.filter(
    (problem) =>
      problem.startsWith("agedrop.toml:") ||
      problem.startsWith("agedrop.lock:") ||
      problem.startsWith("recipients/"),
  );
  if (snapshot.config === undefined || snapshot.lock === undefined || blocking.length > 0) {
    throw new WriteError(
      `the repository does not validate, so nothing is written: ${blocking.join("; ") || "agedrop.toml or agedrop.lock is missing"}`,
    );
  }
  if (secretKind(write.name) === undefined) {
    throw new WriteError(`"${write.name}" is not a valid secret name`);
  }
  const scope = snapshot.scopes.find((view) => view.scope === write.scope);
  if (scope === undefined) throw new WriteError(`scope "${write.scope}" is not in agedrop.toml`);
  if (scope.resolved === undefined) {
    throw new WriteError(`the recipients of scope "${write.scope}" cannot be resolved`);
  }
  const problem = valueProblem(write.name, write.value);
  if (problem !== undefined) throw new WriteError(problem);

  const deletions: string[] = [];
  let message: string;
  const id = secretId(write.scope, write.name);
  const path = secretPath(write.scope, write.name);
  if (write.requestId !== undefined) {
    const request = snapshot.requests.find((open) => open.id === write.requestId);
    if (request === undefined) {
      throw new WriteError(`request ${write.requestId} is no longer open`);
    }
    if (request.scope !== write.scope || request.name !== write.name) {
      throw new WriteError(`request ${write.requestId} asks for ${request.scope}/${request.name}`);
    }
    deletions.push(requestPath(request.id));
    message = `chore(secrets): fulfil ${id} (request ${request.id})`;
  } else {
    const replaced = snapshot.secrets.some((secret) => secret.path === path);
    message = `chore(secrets): ${replaced ? "replace" : "add"} ${id}`;
  }

  const armored = await encryptSecret(write.value, scope.resolved.recipients);
  const lock = await lockSecret(snapshot.lock, id, scope.resolved);
  return {
    branch: snapshot.branch,
    expectedHeadOid: snapshot.head,
    message,
    additions: [
      { path, contents: armored },
      { path: LOCK_FILE, contents: formatLock(lock) },
    ],
    deletions,
  };
}

/**
 * Commits `write`. When the branch moved since `snapshot` was read, reloads the repository, encrypts
 * again to the recipients it now finds and tries once more.
 */
export async function commitWrite(
  client: GitHubClient,
  snapshot: Snapshot,
  write: WriteRequest,
): Promise<{ oid: string; url: string; message: string }> {
  let current = snapshot;
  for (let attempt = 0; ; attempt++) {
    const input = await prepareWrite(current, write);
    try {
      return { ...(await client.commit(input)), message: input.message };
    } catch (error) {
      if (!(error instanceof GitHubError) || !error.stale || attempt > 0) throw error;
      current = await loadSnapshot(client, snapshot.branch);
    }
  }
}

/** 32 random bytes, base64url without padding (SPEC.md § Web UI, Values). */
export function generateValue(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The owner passkey in the web UI (SPEC.md § Web UI, Owner passkey): set up a passkey for an owner,
 * unlock the owner's identity with it (or with the offline backup), and decrypt a secret on request.
 * The unlocked identity lives only in this module's memory, never in storage.
 */
import { webauthn } from "age-encryption";
import {
  decryptSecret,
  formatRecipientFile,
  isValidRecipientName,
  newOwnerIdentity,
  type OwnerIdentity,
  ownerIdentityPath,
  readOwnerIdentity,
  recipientPath,
  unwrapOwnerIdentity,
  wrapOwnerIdentity,
} from "../../src/index.js";
import { type CommitInput, type GitHubClient, GitHubError } from "./github.js";
import { loadSnapshot, type SecretView, type Snapshot } from "./snapshot.js";

/** How long an unlocked identity stays in memory. */
export const UNLOCK_MS = 5 * 60 * 1000;

interface Unlocked {
  readonly name: string;
  readonly identity: string;
  readonly until: number;
  readonly timer: ReturnType<typeof setTimeout>;
}

let unlocked: Unlocked | undefined;
const listeners = new Set<() => void>();

/** The owner whose identity is unlocked, and until when. */
export function unlockedOwner(): { name: string; until: number } | undefined {
  return unlocked === undefined ? undefined : { name: unlocked.name, until: unlocked.until };
}

/** Calls `listener` whenever the page locks or unlocks. */
export function onLockChange(listener: () => void): void {
  listeners.add(listener);
}

export function lock(): void {
  if (unlocked === undefined) return;
  clearTimeout(unlocked.timer);
  unlocked = undefined;
  for (const listener of listeners) listener();
}

function keep(name: string, identity: string): void {
  if (unlocked !== undefined) clearTimeout(unlocked.timer);
  unlocked = {
    name,
    identity,
    until: Date.now() + UNLOCK_MS,
    timer: setTimeout(lock, UNLOCK_MS),
  };
  for (const listener of listeners) listener();
}

/** A failure fit to show, from the passkey prompt or the files. */
export class OwnerError extends Error {
  override readonly name = "OwnerError";
}

/** Turns WebAuthn and typage failures into sentences a person can act on. */
export function describePasskeyError(error: unknown): string {
  if (error instanceof OwnerError) return error.message;
  const name = error instanceof Error ? error.name : "";
  const text = error instanceof Error ? error.message : String(error);
  if (name === "NotAllowedError" || name === "AbortError") {
    return "the passkey prompt was cancelled or timed out";
  }
  if (/PRF extension not available|Missing second PRF result/.test(text)) {
    return "this browser or passkey cannot derive keys (WebAuthn PRF): use Safari on iOS 18.4 or macOS 15 and later, or Chrome 132 and later, with a passkey saved in the system keychain, or unlock with the backup";
  }
  if (name === "InvalidStateError") return "this device already holds that passkey";
  if (typeof navigator === "undefined" || !("credentials" in navigator)) {
    return "this browser has no passkey support: unlock with the backup";
  }
  if (/no identity matched|failed to decrypt/i.test(text)) {
    return "that passkey does not unlock this owner's identity: pick the passkey made for it";
  }
  return text;
}

/** Owners that can be unlocked with a passkey: those with a valid identity file. */
export function passkeyOwners(snapshot: Snapshot): string[] {
  return [...snapshot.ownerIdentities.keys()];
}

/** Unlocks `name`'s identity with a passkey (one Face ID / Touch ID prompt). */
export async function unlockWithPasskey(snapshot: Snapshot, name: string): Promise<void> {
  const wrapped = snapshot.ownerIdentities.get(name);
  const pub = snapshot.recipients.get(name);
  if (wrapped === undefined || pub === undefined) {
    throw new OwnerError(`owner ${name} has no passkey in this repository`);
  }
  const owner = await unwrapOwnerIdentity(wrapped, new webauthn.WebAuthnIdentity(), pub.recipient);
  keep(name, owner.identity);
}

/** Pulls the key out of pasted text, whether it kept its line breaks or not. */
function pastedKey(text: string): string {
  const [only, ...rest] = text.match(/AGE-SECRET-KEY-1[0-9A-Z]+/gi) ?? [];
  return only !== undefined && rest.length === 0 ? only : text;
}

/** Reads a pasted backup and finds the owner whose `.pub` it belongs to. */
export async function readBackup(
  snapshot: Snapshot,
  text: string,
): Promise<{ name: string; owner: OwnerIdentity }> {
  const owner = await readOwnerIdentity(pastedKey(text));
  for (const [name, info] of snapshot.recipients) {
    if (info.recipient === owner.recipient && info.kind === "owner") return { name, owner };
  }
  throw new OwnerError("this identity is not the key of any owner in recipients/");
}

/** Unlocks with the pasted backup identity. */
export async function unlockWithBackup(snapshot: Snapshot, text: string): Promise<string> {
  const { name, owner } = await readBackup(snapshot, text);
  keep(name, owner.identity);
  return name;
}

/** Decrypts one secret with the unlocked identity. The caller wipes the bytes when done. */
export async function revealSecret(client: GitHubClient, secret: SecretView): Promise<Uint8Array> {
  if (unlocked === undefined) throw new OwnerError("unlock first");
  if (secret.sha === undefined) throw new OwnerError(`${secret.path} has no blob to read`);
  const armored = await client.blobText(secret.sha);
  try {
    return await decryptSecret(armored, [unlocked.identity]);
  } catch {
    throw new OwnerError(
      `${unlocked.name} is not a recipient of ${secret.scope}/${secret.name}: rekey it with the CLI`,
    );
  }
}

// ----------------------------------------------------------------------------------------------- setup

/** What the setup is about to do for `name`. */
export type SetupCase =
  | { readonly kind: "new" }
  | { readonly kind: "existing"; readonly recipient: string }
  | { readonly kind: "invalid"; readonly reason: string };

export function setupCase(snapshot: Snapshot, name: string): SetupCase {
  if (!isValidRecipientName(name)) {
    return { kind: "invalid", reason: "lowercase letters, digits, - and _ only" };
  }
  const pub = snapshot.recipients.get(name);
  if (pub !== undefined) {
    return pub.kind === "owner"
      ? { kind: "existing", recipient: pub.recipient }
      : { kind: "invalid", reason: `recipients/${name}.pub is a ${pub.kind} key, not an owner` };
  }
  if (snapshot.recipientFiles.has(name)) {
    return { kind: "invalid", reason: `recipients/${name}.pub does not validate` };
  }
  return { kind: "new" };
}

/** The identity the setup wraps: generated for a new owner, or the existing owner's, checked. */
export async function setupIdentity(
  snapshot: Snapshot,
  name: string,
  pasted: string,
): Promise<OwnerIdentity> {
  const found = setupCase(snapshot, name);
  if (found.kind === "invalid") throw new OwnerError(found.reason);
  if (found.kind === "new") {
    return newOwnerIdentity();
  }
  if (unlocked?.name === name && pasted.trim() === "") {
    return readOwnerIdentity(unlocked.identity);
  }
  const owner = await readOwnerIdentity(pastedKey(pasted));
  if (owner.recipient !== found.recipient) {
    throw new OwnerError(`this identity is not the key in recipients/${name}.pub`);
  }
  return owner;
}

/** Creates the passkey (first Face ID / Touch ID prompt). */
export async function createPasskey(repository: string, name: string): Promise<void> {
  await webauthn.createCredential({ keyName: `agedrop ${name} (${repository})` });
}

/** Wraps the identity with the passkey (second prompt). */
export async function wrapWithPasskey(owner: OwnerIdentity): Promise<string> {
  return wrapOwnerIdentity(owner.file, new webauthn.WebAuthnRecipient());
}

export interface OwnerSetup {
  readonly name: string;
  readonly owner: OwnerIdentity;
  /** The armored `recipients/<name>.identity.age`. */
  readonly wrapped: string;
}

/** Builds the setup commit against `snapshot`. */
export function prepareOwnerCommit(
  snapshot: Snapshot,
  setup: OwnerSetup,
  today: string,
): CommitInput {
  const found = setupCase(snapshot, setup.name);
  if (found.kind === "invalid") throw new OwnerError(found.reason);
  if (found.kind === "existing" && found.recipient !== setup.owner.recipient) {
    throw new OwnerError(`recipients/${setup.name}.pub changed: start the setup again`);
  }
  const additions = [{ path: ownerIdentityPath(setup.name), contents: setup.wrapped }];
  if (found.kind === "new") {
    additions.unshift({
      path: recipientPath(setup.name),
      contents: formatRecipientFile({
        kind: "owner",
        added: today,
        recipient: setup.owner.recipient,
      }),
    });
  }
  return {
    branch: snapshot.branch,
    expectedHeadOid: snapshot.head,
    message:
      found.kind === "new"
        ? `chore(recipients): add owner ${setup.name} with a passkey`
        : `chore(recipients): set the passkey of owner ${setup.name}`,
    additions,
    deletions: [],
  };
}

/** Commits the setup, retrying once on a moved branch, then keeps the identity unlocked. */
export async function commitOwnerSetup(
  client: GitHubClient,
  snapshot: Snapshot,
  setup: OwnerSetup,
): Promise<{ oid: string; url: string; message: string }> {
  const today = new Date().toISOString().slice(0, 10);
  let current = snapshot;
  for (let attempt = 0; ; attempt++) {
    const input = prepareOwnerCommit(current, setup, today);
    try {
      const result = { ...(await client.commit(input)), message: input.message };
      keep(setup.name, setup.owner.identity);
      return result;
    } catch (error) {
      if (!(error instanceof GitHubError) || !error.stale || attempt > 0) throw error;
      current = await loadSnapshot(client, snapshot.branch);
    }
  }
}

/**
 * Owner identity files (SPEC.md § Recipients, Owner identity files): an owner's X25519 identity in
 * `age-keygen` format, wrapped by a passkey into `recipients/<name>.identity.age`. The passkey itself is
 * any age `Recipient` / `Identity` (typage's `WebAuthnRecipient` in the browser), so this module does no
 * I/O and needs no browser.
 */
import {
  armor,
  Decrypter,
  Encrypter,
  generateX25519Identity,
  type Identity,
  identityToRecipient,
  type Recipient,
} from "age-encryption";
import { isValidRecipientName, RECIPIENTS_DIR } from "./names.js";
import type { RecipientInfo } from "./recipients.js";
import { isAgeArmor } from "./secret.js";

export const OWNER_IDENTITY_EXTENSION = ".identity.age";

/** `recipients/<name>.identity.age`. */
export function ownerIdentityPath(name: string): string {
  if (!isValidRecipientName(name)) throw new Error(`invalid recipient name "${name}"`);
  return `${RECIPIENTS_DIR}/${name}${OWNER_IDENTITY_EXTENSION}`;
}

/** An owner's key pair and its identity file in `age-keygen` format. */
export interface OwnerIdentity {
  /** `AGE-SECRET-KEY-1…`. */
  readonly identity: string;
  /** `age1…`. */
  readonly recipient: string;
  /** The identity file: `# created`, `# public key` and the key, as `age-keygen` writes it. */
  readonly file: string;
}

/** Generates an X25519 owner identity. */
export async function newOwnerIdentity(now = new Date()): Promise<OwnerIdentity> {
  const identity = await generateX25519Identity();
  const recipient = await identityToRecipient(identity);
  return { identity, recipient, file: formatIdentityFile(identity, recipient, now) };
}

/** An identity file in `age-keygen` format. */
export function formatIdentityFile(identity: string, recipient: string, created: Date): string {
  const date = created.toISOString().replace(/\.\d+Z$/, "Z");
  return `# created: ${date}\n# public key: ${recipient}\n${identity}\n`;
}

/**
 * Reads one X25519 identity from pasted text: an `age-keygen` identity file or the bare key. Throws
 * an error that never repeats the text, because it may hold a private key.
 */
export async function readOwnerIdentity(text: string, now = new Date()): Promise<OwnerIdentity> {
  const keys = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  if (keys.length !== 1) {
    throw new Error(
      keys.length === 0
        ? "no AGE-SECRET-KEY-1… line found"
        : "expected one AGE-SECRET-KEY-1… line, found several lines",
    );
  }
  const identity = (keys[0] ?? "").toUpperCase();
  if (!identity.startsWith("AGE-SECRET-KEY-1")) {
    throw new Error("not an X25519 age identity (AGE-SECRET-KEY-1…)");
  }
  let recipient: string;
  try {
    recipient = await identityToRecipient(identity);
  } catch {
    throw new Error("not a valid age identity: check that it was copied whole");
  }
  return { identity, recipient, file: formatIdentityFile(identity, recipient, now) };
}

/** Wraps an identity file with `wrapper` (a passkey) into an armored age file. */
export async function wrapOwnerIdentity(identityFile: string, wrapper: Recipient): Promise<string> {
  const encrypter = new Encrypter();
  encrypter.addRecipient(wrapper);
  return armor.encode(await encrypter.encrypt(identityFile));
}

/**
 * Unwraps `recipients/<name>.identity.age` with `unwrapper` (a passkey) and returns the identity, after
 * checking that its public key is `expectedRecipient` (the owner's `.pub`).
 */
export async function unwrapOwnerIdentity(
  armored: string,
  unwrapper: Identity,
  expectedRecipient: string,
): Promise<OwnerIdentity> {
  const decrypter = new Decrypter();
  decrypter.addIdentity(unwrapper);
  const file = await decrypter.decrypt(armor.decode(armored), "text");
  const owner = await readOwnerIdentity(file);
  if (owner.recipient !== expectedRecipient) {
    throw new Error("the wrapped identity does not match the owner's public key in recipients/");
  }
  return { ...owner, file };
}

/**
 * Problems with `recipients/<name>.identity.age`, as `agedrop check` reports them. Decrypts nothing:
 * the file must be armored age and sit next to an owner's `.pub`. `pub` is that file parsed, or
 * `"invalid"` when it exists but does not parse (reported on its own).
 */
export function ownerIdentityIssues(
  name: string,
  text: string,
  pub: RecipientInfo | "invalid" | undefined,
): string[] {
  if (!isValidRecipientName(name)) return [`invalid recipient name "${name}"`];
  const issues: string[] = [];
  if (!isAgeArmor(text)) issues.push("not an ASCII-armored age file");
  if (pub === undefined) issues.push(`no ${RECIPIENTS_DIR}/${name}.pub next to it`);
  else if (pub !== "invalid" && pub.kind !== "owner") {
    issues.push(`${RECIPIENTS_DIR}/${name}.pub is of kind "${pub.kind}", not "owner"`);
  }
  return issues;
}

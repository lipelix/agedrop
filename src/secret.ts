import { armor, Decrypter, Encrypter } from "age-encryption";

/**
 * Encrypts one secret value to the given age recipients and returns the ASCII-armored file.
 * A string value is encoded as UTF-8; bytes are stored exactly.
 */
export async function encryptSecret(
  value: string | Uint8Array,
  recipients: readonly string[],
): Promise<string> {
  if (recipients.length === 0) throw new Error("cannot encrypt a secret to no recipients");
  const encrypter = new Encrypter();
  for (const recipient of recipients) encrypter.addRecipient(recipient);
  return armor.encode(await encrypter.encrypt(value));
}

/**
 * Decrypts an ASCII-armored secret file with any of the given identities (`AGE-SECRET-KEY-1…`).
 * Throws when none of them is a recipient of the file.
 */
export async function decryptSecret(
  armored: string,
  identities: readonly string[],
): Promise<Uint8Array> {
  if (identities.length === 0) throw new Error("cannot decrypt a secret without an identity");
  const decrypter = new Decrypter();
  for (const identity of identities) decrypter.addIdentity(identity);
  return decrypter.decrypt(armor.decode(armored));
}

/** Like {@link decryptSecret}, decoding the value as UTF-8. */
export async function decryptSecretText(
  armored: string,
  identities: readonly string[],
): Promise<string> {
  return new TextDecoder("utf-8", { fatal: true }).decode(await decryptSecret(armored, identities));
}

/**
 * Reads identities from the contents of an age identity file (as written by `age-keygen`):
 * one `AGE-SECRET-KEY-…` per line, `#` comments and blank lines ignored.
 */
export function parseIdentityFile(text: string): string[] {
  const identities = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  for (const identity of identities) {
    if (!identity.startsWith("AGE-SECRET-KEY-")) {
      throw new Error("identity file holds a line that is not an AGE-SECRET-KEY");
    }
  }
  if (identities.length === 0) throw new Error("identity file holds no AGE-SECRET-KEY");
  return identities;
}

const AGE_HEADER = new TextEncoder().encode("age-encryption.org/v1\n");

/** Whether `text` is an ASCII-armored age file. Reads only the header; decrypts nothing. */
export function isAgeArmor(text: string): boolean {
  try {
    const bytes = armor.decode(text);
    return AGE_HEADER.every((byte, i) => bytes[i] === byte);
  } catch {
    return false;
  }
}

const CHUNK = 64 * 1024;
const TAG = 16;
const NONCE = 16;
const MAC_LINE = new TextEncoder().encode("\n--- ");

/**
 * The plaintext length of an ASCII-armored age file, read from its size without decrypting it: the payload
 * is a 16-byte nonce, then the plaintext in 64 KiB chunks with a 16-byte tag each (at least one chunk).
 * `undefined` when the file is not an age file.
 */
export function plaintextLength(armored: string): number | undefined {
  if (!isAgeArmor(armored)) return undefined;
  const bytes = armor.decode(armored);
  let mac = -1;
  for (let i = 0; i + MAC_LINE.length <= bytes.length && mac === -1; i++) {
    if (MAC_LINE.every((byte, j) => bytes[i + j] === byte)) mac = i;
  }
  const headerEnd = mac === -1 ? -1 : bytes.indexOf(0x0a, mac + 1);
  if (headerEnd === -1) return undefined;
  const sealed = bytes.length - (headerEnd + 1) - NONCE;
  const chunks = Math.max(1, Math.ceil(sealed / (CHUNK + TAG)));
  const length = sealed - chunks * TAG;
  return length < 0 ? undefined : length;
}

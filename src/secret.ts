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

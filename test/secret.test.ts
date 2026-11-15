import { describe, expect, it } from "vitest";
import {
  decryptSecret,
  decryptSecretText,
  encryptSecret,
  parseIdentityFile,
} from "../src/index.js";
import { throwawayKey } from "./helpers.js";

describe("secret files", () => {
  it("encrypts to every recipient as armored age", async () => {
    const a = await throwawayKey();
    const b = await throwawayKey();
    const file = await encryptSecret("s3cret value", [a.recipient, b.recipient]);
    expect(file.startsWith("-----BEGIN AGE ENCRYPTED FILE-----\n")).toBe(true);
    expect(file.endsWith("-----END AGE ENCRYPTED FILE-----\n")).toBe(true);
    expect(await decryptSecretText(file, [a.identity])).toBe("s3cret value");
    expect(await decryptSecretText(file, [b.identity])).toBe("s3cret value");
  });

  it("keeps bytes exactly, including trailing newlines and empty values", async () => {
    const k = await throwawayKey();
    const bytes = new Uint8Array([0, 255, 10, 13, 10]);
    expect(await decryptSecret(await encryptSecret(bytes, [k.recipient]), [k.identity])).toEqual(
      bytes,
    );
    expect(
      await decryptSecretText(await encryptSecret("line\n", [k.recipient]), [k.identity]),
    ).toBe("line\n");
    expect(await decryptSecretText(await encryptSecret("", [k.recipient]), [k.identity])).toBe("");
  });

  it("fails for a non-recipient and for no recipients", async () => {
    const a = await throwawayKey();
    const stranger = await throwawayKey();
    const file = await encryptSecret("x", [a.recipient]);
    await expect(decryptSecret(file, [stranger.identity])).rejects.toThrow();
    await expect(encryptSecret("x", [])).rejects.toThrow(/no recipients/);
    await expect(decryptSecret(file, [])).rejects.toThrow(/without an identity/);
  });

  it("reads age-keygen style identity files", async () => {
    const k = await throwawayKey();
    expect(
      parseIdentityFile(`# created: now\n# public key: ${k.recipient}\n${k.identity}\n`),
    ).toEqual([k.identity]);
    expect(() => parseIdentityFile("# nothing\n")).toThrow(/no AGE-SECRET-KEY/);
    expect(() => parseIdentityFile(`${k.recipient}\n`)).toThrow(/not an AGE-SECRET-KEY/);
  });
});

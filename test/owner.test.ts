import { webauthn } from "age-encryption";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  decryptSecretText,
  encryptSecret,
  formatIdentityFile,
  newOwnerIdentity,
  ownerIdentityIssues,
  ownerIdentityPath,
  parseRecipientFile,
  readOwnerIdentity,
  unwrapOwnerIdentity,
  wrapOwnerIdentity,
} from "../src/index.js";
import { installFakePasskeys } from "./fake-passkey.js";
import { ageDecrypt, throwawayKey } from "./helpers.js";

beforeEach(() => {
  vi.stubGlobal("window", { origin: "https://app.agedrop.dev" });
  installFakePasskeys();
});

async function passkey(): Promise<void> {
  await webauthn.createCredential({ keyName: "agedrop owner (someone/home-secrets)" });
}

describe("owner identity files", () => {
  it("wraps a new identity with a passkey and unwraps it to the same key", async () => {
    await passkey();
    const owner = await newOwnerIdentity(new Date("2026-11-14T10:00:00.123Z"));
    expect(owner.file).toBe(
      `# created: 2026-11-14T10:00:00Z\n# public key: ${owner.recipient}\n${owner.identity}\n`,
    );

    const wrapped = await wrapOwnerIdentity(owner.file, new webauthn.WebAuthnRecipient());
    expect(wrapped.startsWith("-----BEGIN AGE ENCRYPTED FILE-----\n")).toBe(true);
    expect(wrapped).not.toContain(owner.identity);
    expect(globalThis.fakePasskeys?.gets).toBe(1);

    const unwrapped = await unwrapOwnerIdentity(
      wrapped,
      new webauthn.WebAuthnIdentity(),
      owner.recipient,
    );
    expect(unwrapped.identity).toBe(owner.identity);
    expect(unwrapped.file).toBe(owner.file);
    expect(globalThis.fakePasskeys?.gets).toBe(2);
  });

  it("the unwrapped identity reads secrets, and the backup reads them with the stock age CLI", async () => {
    await passkey();
    const owner = await newOwnerIdentity();
    const wrapped = await wrapOwnerIdentity(owner.file, new webauthn.WebAuthnRecipient());
    const secret = await encryptSecret("postgres://throwaway", [owner.recipient]);

    const unwrapped = await unwrapOwnerIdentity(
      wrapped,
      new webauthn.WebAuthnIdentity(),
      owner.recipient,
    );
    expect(await decryptSecretText(secret, [unwrapped.identity])).toBe("postgres://throwaway");
    // The backup is the identity file as shown once; `age -d -i backup` reads every secret.
    expect(await ageDecrypt(secret, owner.file)).toBe("postgres://throwaway");
  });

  it("refuses another passkey and an identity that does not match the owner's .pub", async () => {
    await passkey();
    const owner = await newOwnerIdentity();
    const wrapped = await wrapOwnerIdentity(owner.file, new webauthn.WebAuthnRecipient());
    const other = await throwawayKey();
    await expect(
      unwrapOwnerIdentity(wrapped, new webauthn.WebAuthnIdentity(), other.recipient),
    ).rejects.toThrow(/does not match/);

    await passkey(); // the newest passkey is picked next: not the one the file was wrapped with
    await expect(
      unwrapOwnerIdentity(wrapped, new webauthn.WebAuthnIdentity(), owner.recipient),
    ).rejects.toThrow();
  });

  it("reports a passkey without PRF", async () => {
    if (globalThis.fakePasskeys) globalThis.fakePasskeys.noPrf = true;
    await expect(passkey()).rejects.toThrow(/PRF extension not available/);
  });

  it("reads a pasted identity file or bare key, never echoing it in errors", async () => {
    const key = await throwawayKey();
    const file = formatIdentityFile(key.identity, key.recipient, new Date("2026-11-14T00:00:00Z"));
    expect((await readOwnerIdentity(file)).recipient).toBe(key.recipient);
    expect((await readOwnerIdentity(`  ${key.identity.toLowerCase()}  \n`)).identity).toBe(
      key.identity,
    );

    const broken = `${key.identity.slice(0, -4)}QQQQ`;
    const failure = await readOwnerIdentity(broken).then(
      () => new Error("accepted"),
      (error: unknown) => error as Error,
    );
    expect(failure.message).toMatch(/not a valid age identity/);
    expect(failure.message).not.toContain(broken);
    await expect(readOwnerIdentity("# only comments\n")).rejects.toThrow(/no AGE-SECRET-KEY/);
    await expect(readOwnerIdentity(`${key.identity}\n${key.identity}\n`)).rejects.toThrow(
      /several/,
    );
    await expect(readOwnerIdentity(key.recipient)).rejects.toThrow(/not an X25519 age identity/);
  });

  it("names the file and checks it without decrypting", async () => {
    expect(ownerIdentityPath("libor")).toBe("recipients/libor.identity.age");
    expect(() => ownerIdentityPath("Libor")).toThrow(/invalid recipient name/);

    const key = await throwawayKey();
    const owner = parseRecipientFile("libor", `# kind: owner\n${key.recipient}\n`);
    const machine = parseRecipientFile("mini", `# kind: machine\n${key.recipient}\n`);
    const armored = await encryptSecret("x", [key.recipient]);
    expect(ownerIdentityIssues("libor", armored, owner)).toEqual([]);
    expect(ownerIdentityIssues("libor", "not age", owner)).toEqual([
      "not an ASCII-armored age file",
    ]);
    expect(ownerIdentityIssues("libor", armored, undefined)).toEqual([
      "no recipients/libor.pub next to it",
    ]);
    expect(ownerIdentityIssues("libor", armored, "invalid")).toEqual([]);
    expect(ownerIdentityIssues("mini", armored, machine)).toEqual([
      'recipients/mini.pub is of kind "machine", not "owner"',
    ]);
  });
});

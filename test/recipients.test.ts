import { Encrypter, generateHybridIdentity, identityToRecipient } from "age-encryption";
import { describe, expect, it } from "vitest";
import {
  formatRecipientFile,
  FormatError,
  isAgeRecipient,
  parseRecipientFile,
} from "../src/index.js";
import { throwawayKey, throwawayTagRecipients } from "./helpers.js";

const TAG_LOOKALIKE = "age1tagrm2uf6l0jf2gqtkk2vxx2l9klgfyr04skfp93zque8aa0sa5sh8h4an";

function issuesOf(name: string, text: string): readonly string[] {
  try {
    parseRecipientFile(name, text);
  } catch (error) {
    if (error instanceof FormatError) return error.issues;
    throw error;
  }
  throw new Error("expected a FormatError");
}

describe("recipient files", () => {
  it("parses the SPEC.md layout", async () => {
    const { recipient } = await throwawayKey();
    const info = parseRecipientFile(
      "server",
      `# kind: machine\n# added: 2026-11-09\n# note: in the closet\n\n  ${recipient}  \n`,
    );
    expect(info).toMatchObject({
      name: "server",
      kind: "machine",
      added: "2026-11-09",
      recipient,
    });
    expect(info.metadata.get("note")).toBe("in the closet");
  });

  it("round-trips through formatRecipientFile", async () => {
    const { recipient } = await throwawayKey();
    const text = formatRecipientFile({ kind: "owner", added: "2026-11-14", recipient });
    expect(text).toBe(`# kind: owner\n# added: 2026-11-14\n${recipient}\n`);
    expect(parseRecipientFile("libor", text)).toMatchObject({ kind: "owner", recipient });
    expect(
      parseRecipientFile("ci", formatRecipientFile({ kind: "ci", recipient })).added,
    ).toBeUndefined();
  });

  it("requires a known kind", async () => {
    const { recipient } = await throwawayKey();
    expect(issuesOf("a", `${recipient}\n`)).toEqual([`missing "# kind: machine | ci | owner"`]);
    expect(issuesOf("a", `# kind: server\n${recipient}\n`)).toEqual([
      `unknown kind "server" (expected machine, ci, owner)`,
    ]);
  });

  it("requires exactly one valid recipient", async () => {
    const a = await throwawayKey();
    const b = await throwawayKey();
    expect(issuesOf("a", `# kind: ci\n`)).toEqual([`missing the age recipient line (age1…)`]);
    expect(issuesOf("a", `# kind: ci\n${a.recipient}\n${b.recipient}\n`)).toEqual([
      `expected one age recipient, found 2`,
    ]);
    expect(issuesOf("a", `# kind: ci\nage1notakey\n`)).toEqual([
      `not a valid age recipient: "age1notakey"`,
    ]);
    expect(issuesOf("a", `# kind: ci\n${a.identity}\n`)[0]).toMatch(/^holds a private key/);
  });

  it("rejects bad dates, repeated keys and bad names", async () => {
    const { recipient } = await throwawayKey();
    expect(issuesOf("a", `# kind: ci\n# added: 2026-13-01\n${recipient}\n`)).toEqual([
      `"added" must be a date YYYY-MM-DD`,
    ]);
    expect(issuesOf("a", `# kind: ci\n# kind: owner\n${recipient}\n`)).toEqual([
      `"kind" is set twice`,
    ]);
    expect(issuesOf("Bad", `# kind: ci\n${recipient}\n`)).toEqual([`invalid recipient name "Bad"`]);
  });

  it("accepts X25519 and post-quantum recipients only", async () => {
    const { recipient } = await throwawayKey();
    expect(isAgeRecipient(recipient)).toBe(true);
    expect(isAgeRecipient(recipient.slice(0, -1) + (recipient.endsWith("q") ? "p" : "q"))).toBe(
      false,
    );
    expect(isAgeRecipient(await identityToRecipient(await generateHybridIdentity()))).toBe(true);
    expect(isAgeRecipient("ssh-ed25519 AAAA")).toBe(false);
    expect(isAgeRecipient("age1yubikey1qwerty")).toBe(false);
    expect(isAgeRecipient("agenoseparator")).toBe(false);
  });

  it("rejects tag recipients that typage would accept", () => {
    const { tag, tagpq } = throwawayTagRecipients();
    for (const recipient of [tag, tagpq]) {
      expect(() => {
        new Encrypter().addRecipient(recipient);
      }).not.toThrow();
      expect(isAgeRecipient(recipient)).toBe(false);
    }
  });

  it("accepts X25519 recipients whose data starts with tag", () => {
    // Public key of a throwaway identity that once broke CI; `age-cli.test.ts` checks it too.
    expect(isAgeRecipient(TAG_LOOKALIKE)).toBe(true);
    expect(
      parseRecipientFile("ci", formatRecipientFile({ kind: "ci", recipient: TAG_LOOKALIKE })),
    ).toMatchObject({ recipient: TAG_LOOKALIKE });
  });
});

describe("parseRecipientFile with a private key", () => {
  it("rejects it without echoing the key", async () => {
    const { identity } = await throwawayKey();
    let message = "";
    try {
      parseRecipientFile("libor", `# kind: owner\n${identity}\n`);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/holds a private key/);
    expect(message).not.toContain(identity);
  });
});

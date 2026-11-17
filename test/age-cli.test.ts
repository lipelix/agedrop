/**
 * Compatibility with the Go `age` CLI (AGENTS.md: every secret file must decrypt with stock `age`).
 * These tests need `age` and `age-keygen` on PATH, or AGE_BIN / AGE_KEYGEN_BIN. They fail, not skip,
 * when the binaries are missing, so CI cannot pass without running them.
 */
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { armor } from "age-encryption";
import { beforeAll, describe, expect, it } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  formatRecipientFile,
  parseConfig,
  parseIdentityFile,
  parseRecipientFile,
  plaintextLength,
  type RecipientInfo,
  resolveScope,
} from "../src/index.js";
import { endStdin, run, throwawayKey, withTempDir } from "./helpers.js";

const AGE = process.env.AGE_BIN ?? "age";
const AGE_KEYGEN = process.env.AGE_KEYGEN_BIN ?? "age-keygen";

/** Runs `age` with stdin, returning stdout as bytes. */
function age(args: string[], input: Uint8Array | string = ""): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const child = spawn(AGE, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(new Uint8Array(Buffer.concat(out)));
      else
        reject(
          new Error(
            `age ${args.join(" ")} exited ${String(code)}: ${Buffer.concat(err).toString()}`,
          ),
        );
    });
    endStdin(child.stdin, input, reject);
  });
}

/** A key pair made by `age-keygen`, written to `<dir>/<name>.key`. */
async function keygen(dir: string, name: string): Promise<{ keyFile: string; recipient: string }> {
  const keyFile = join(dir, `${name}.key`);
  await run(AGE_KEYGEN, ["-o", keyFile]);
  const { stdout } = await run(AGE_KEYGEN, ["-y", keyFile]);
  return { keyFile, recipient: stdout.trim() };
}

const VALUES: [string, Uint8Array][] = [
  ["a short env value", new TextEncoder().encode("hunter2")],
  ["a value with a trailing newline", new TextEncoder().encode("token\n")],
  ["an empty value", new Uint8Array()],
  ["UTF-8 text", new TextEncoder().encode("přístupový klíč 🔑")],
  ["binary bytes", Uint8Array.from({ length: 256 }, (_, i) => i)],
  // Larger than one 64 KiB age payload chunk, so multi-chunk streams are covered too.
  ["a multi-chunk value", Uint8Array.from({ length: 200_000 }, (_, i) => (i * 7919) % 251)],
];

describe("age CLI compatibility", () => {
  beforeAll(async () => {
    const { stdout } = await run(AGE, ["--version"]);
    expect(stdout.trim()).toMatch(/^v?\d+\.\d+/);
  });

  it.each(VALUES)("age decrypts %s written by the library", async (_label, value) => {
    await withTempDir(async (dir) => {
      const a = await keygen(dir, "a");
      const b = await keygen(dir, "b");
      const armored = await encryptSecret(value, [a.recipient, b.recipient]);
      const file = join(dir, "SECRET.age");
      await writeFile(file, armored);
      expect(await age(["-d", "-i", a.keyFile, file])).toEqual(value);
      expect(await age(["-d", "-i", b.keyFile, file])).toEqual(value);
    });
  });

  it.each(VALUES)("the library decrypts %s written by age -a", async (_label, value) => {
    await withTempDir(async (dir) => {
      const a = await keygen(dir, "a");
      const b = await keygen(dir, "b");
      const armored = new TextDecoder().decode(
        await age(["-a", "-r", a.recipient, "-r", b.recipient], value),
      );
      expect(armored.startsWith("-----BEGIN AGE ENCRYPTED FILE-----")).toBe(true);
      for (const keyFile of [a.keyFile, b.keyFile]) {
        const identities = parseIdentityFile(await readFile(keyFile, "utf8"));
        expect(await decryptSecret(armored, identities)).toEqual(value);
      }
      // ls and check read a value's length from the file without a key (exec --redact warnings).
      expect(plaintextLength(armored)).toBe(value.length);
    });
  });

  it("the age helper reports an early exit instead of an unhandled EPIPE", async () => {
    // age exits on the missing identity before reading stdin; 1 MB overflows the pipe buffer.
    await withTempDir(async (dir) => {
      await expect(
        age(["-d", "-i", join(dir, "missing.key")], new Uint8Array(1_000_000)),
      ).rejects.toThrow(/exited 1/);
    });
  });

  it("age reads library identities and recipients files", async () => {
    await withTempDir(async (dir) => {
      const k = await throwawayKey();
      const keyFile = join(dir, "identity");
      await writeFile(keyFile, `${k.identity}\n`, { mode: 0o600 });
      const { stdout } = await run(AGE_KEYGEN, ["-y", keyFile]);
      expect(stdout.trim()).toBe(k.recipient);

      // A `.pub` file is a valid `age -R` recipients file: comments are skipped.
      const pub = join(dir, "libor.pub");
      await writeFile(
        pub,
        formatRecipientFile({ kind: "owner", added: "2026-11-14", recipient: k.recipient }),
      );
      const armored = new TextDecoder().decode(await age(["-a", "-R", pub], "via -R"));
      expect(new TextDecoder().decode(await decryptSecret(armored, [k.identity]))).toBe("via -R");
    });
  });

  it("age and the library treat an X25519 key whose data starts with tag as X25519", async () => {
    // Public key of a throwaway identity, the lookalike that once broke CI.
    const recipient = "age1tagrm2uf6l0jf2gqtkk2vxx2l9klgfyr04skfp93zque8aa0sa5sh8h4an";
    await withTempDir(async (dir) => {
      const pub = join(dir, "ci.pub");
      await writeFile(pub, formatRecipientFile({ kind: "ci", recipient }));
      const fromAge = new TextDecoder().decode(await age(["-R", pub], "lookalike"));
      expect(fromAge).toMatch(/^-> X25519 /m);

      const info = parseRecipientFile("ci", formatRecipientFile({ kind: "ci", recipient }));
      const armored = await encryptSecret("lookalike", [info.recipient]);
      expect(new TextDecoder().decode(armor.decode(armored))).toMatch(/^-> X25519 /m);
    });
  });

  it("a scope's secret decrypts with age for each member and no one else", async () => {
    await withTempDir(async (dir) => {
      const config = parseConfig(`version = 0
[recipients]
owners = ["libor"]
mini = ["server"]
ci = ["github-actions"]
[scopes."mini/hq"]
recipients = ["owners", "mini"]
`);
      const keys = {
        libor: await keygen(dir, "libor"),
        server: await keygen(dir, "server"),
        "github-actions": await keygen(dir, "github-actions"),
      };
      const recipients = new Map<string, RecipientInfo>(
        Object.entries(keys).map(([name, key]) => [
          name,
          parseRecipientFile(
            name,
            formatRecipientFile({ kind: "machine", recipient: key.recipient }),
          ),
        ]),
      );
      const scope = resolveScope(config, recipients, "mini/hq");
      const file = join(dir, "VAPID_PRIVATE_KEY.age");
      await writeFile(file, await encryptSecret("scoped", scope.recipients));

      for (const member of ["libor", "server"] as const) {
        expect(new TextDecoder().decode(await age(["-d", "-i", keys[member].keyFile, file]))).toBe(
          "scoped",
        );
      }
      await expect(age(["-d", "-i", keys["github-actions"].keyFile, file])).rejects.toThrow(
        /no identity matched/,
      );
    });
  });
});

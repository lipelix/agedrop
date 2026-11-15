import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { Context } from "../src/cli/context.js";
import { readHiddenLine } from "../src/cli/input.js";
import { decryptSecretText } from "../src/index.js";
import { writeFileAtomic } from "../src/node.js";
import { makeRepo, runCli } from "./cli-helpers.js";
import { withTempDir } from "./helpers.js";

const REQUEST = `scope = "host/app"
name = "API_KEY"
reason = "needed for the deploy"
requested_by = "agent session"
created = "2026-11-09T10:00:00Z"
`;

describe("agedrop (no command)", () => {
  it("prints usage and exits 2; --help exits 0", async () => {
    await withTempDir(async (dir) => {
      let result = await runCli([], { cwd: dir, home: dir });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("usage: agedrop <command>");
      result = await runCli(["--help"], { cwd: dir, home: dir });
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/^ {2}pull +decrypt a scope/m);
      for (const name of ["request", "requests", "fulfil", "rekey"]) {
        expect(result.stdout).toMatch(new RegExp(`^ {2}${name} +\\S`, "m"));
      }
      result = await runCli(["frobnicate"], { cwd: dir, home: dir });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(`unknown command "frobnicate"`);
      result = await runCli(["pull", "--help"], { cwd: dir, home: dir });
      expect(result.stdout).toMatch(/^usage: agedrop pull/);
      result = await runCli(["--version"], { cwd: dir, home: dir });
      expect(result.stdout).toMatch(/^\d+\.\d+\.\d+\n$/);
    });
  });

  it("fails outside a repository", async () => {
    await withTempDir(async (dir) => {
      const result = await runCli(["ls"], { cwd: dir, home: dir });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("not in an agedrop repository");
    });
  });
});

describe("agedrop init", () => {
  it("refuses to overwrite agedrop.toml and validates the owner name", async () => {
    await withTempDir(async (dir) => {
      expect((await runCli(["init", "--owner", "Bad Name"], { cwd: dir, home: dir })).code).toBe(2);
      expect((await runCli(["init"], { cwd: dir, home: dir })).code).toBe(2);
      expect((await runCli(["init", "--owner", "me"], { cwd: dir, home: dir })).code).toBe(0);
      const again = await runCli(["init", "--owner", "me"], { cwd: dir, home: dir });
      expect(again.code).toBe(1);
      expect(again.stderr).toContain("already exists");
      expect(await readFile(join(dir, "agedrop.lock"), "utf8")).toBe("version = 0\n\n[secrets]\n");
    });
  });
});

describe("agedrop keygen", () => {
  it("never overwrites an identity or a .pub file", async () => {
    await withTempDir(async (dir) => {
      await makeRepo(dir);
      let result = await runCli(["keygen", "host"], { cwd: dir, home: dir });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("recipients/host.pub already exists");

      result = await runCli(["keygen", "new-host"], { cwd: dir, home: dir });
      expect(result.code, result.stderr).toBe(0);
      const identityPath = join(dir, ".config", "agedrop", "identity");
      const identity = await readFile(identityPath, "utf8");
      expect((await stat(join(dir, ".config", "agedrop"))).mode & 0o777).toBe(0o700);

      result = await runCli(["keygen", "third"], { cwd: dir, home: dir });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("keygen never overwrites an identity");
      expect(await readFile(identityPath, "utf8")).toBe(identity);
    });
  });

  it("prints the .pub file outside a repository", async () => {
    await withTempDir(async (dir) => {
      const result = await runCli(["keygen", "laptop", "--out", "id"], { cwd: dir, home: dir });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/^# kind: machine\n# added: \d{4}-\d{2}-\d{2}\nage1\w+\n$/);
      expect(await readFile(join(dir, "id"), "utf8")).toMatch(/^AGE-SECRET-KEY-1\w+$/m);
    });
  });

  it("rejects an unknown kind", async () => {
    await withTempDir(async (dir) => {
      const result = await runCli(["keygen", "x", "--kind", "robot"], { cwd: dir, home: dir });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(`unknown kind "robot"`);
    });
  });
});

describe("agedrop add", () => {
  it("encrypts stdin to the scope and records the lock", async () => {
    await withTempDir(async (dir) => {
      const keys = await makeRepo(dir);
      const result = await runCli(["add", "host/app", "API_KEY"], {
        cwd: dir,
        home: dir,
        stdin: "v4lue",
      });
      expect(result.code, result.stderr).toBe(0);
      const armored = await readFile(join(dir, "secrets/host/app/API_KEY.age"), "utf8");
      expect(await decryptSecretText(armored, [keys.host])).toBe("v4lue");
      expect(await decryptSecretText(armored, [keys.owner])).toBe("v4lue");
      expect(await readFile(join(dir, "agedrop.lock"), "utf8")).toMatch(
        /^"host\/app\/API_KEY" = "sha256:[0-9a-f]{64}"$/m,
      );
    });
  });

  it("refuses values from arguments, bad names, empty and binary env values", async () => {
    await withTempDir(async (dir) => {
      await makeRepo(dir);
      const cases: [string[], string | Buffer, number, string][] = [
        [["add", "host/app", "API_KEY", "value"], "", 2, "never from arguments"],
        [["add", "host/app", "MixedCase"], "x", 2, `invalid secret name "MixedCase"`],
        [["add", "host/app", "API_KEY"], "", 1, "empty value"],
        [["add", "host/app", "API_KEY"], Buffer.from([0x61, 0x00]), 1, "UTF-8 text without NUL"],
      ];
      for (const [argv, stdin, code, message] of cases) {
        const result = await runCli(argv, { cwd: dir, home: dir, stdin });
        expect(result.code, argv.join(" ")).toBe(code);
        expect(result.stderr).toContain(message);
      }
      // Binary values are fine for file-style names.
      const result = await runCli(["add", "host/app", "blob.bin"], {
        cwd: dir,
        home: dir,
        stdin: Buffer.from([0x00, 0xff]),
      });
      expect(result.code, result.stderr).toBe(0);
    });
  });
});

describe("agedrop pull", () => {
  it("needs exactly one destination, and one secret for --to -", async () => {
    await withTempDir(async (dir) => {
      const keys = await makeRepo(dir);
      await writeFile(join(dir, "host.key"), `${keys.host}\n`, { mode: 0o600 });
      for (const name of ["A", "B"]) {
        await runCli(["add", "host/app", name], { cwd: dir, home: dir, stdin: name });
      }
      let result = await runCli(["pull", "host/app"], { cwd: dir, home: dir });
      expect(result.code).toBe(2);
      result = await runCli(["pull", "host/app", "--to", "x", "--env", "y"], {
        cwd: dir,
        home: dir,
      });
      expect(result.code).toBe(2);
      result = await runCli(["pull", "host/app", "--to", "-", "--identity", "host.key"], {
        cwd: dir,
        home: dir,
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("--to - prints one value, and 2 secrets match");
      expect(result.stdout).toBe("");
      result = await runCli(["pull", "host/app", "C", "--to", "-", "--identity", "host.key"], {
        cwd: dir,
        home: dir,
      });
      expect(result.stderr).toBe("agedrop: no secret secrets/host/app/C.age\n");
      result = await runCli(["pull", "host/app", "B", "--to", "-", "--identity", "host.key"], {
        cwd: dir,
        home: dir,
      });
      expect(result.stdout).toBe("B");
    });
  });

  it("warns about an identity file other users can read", async () => {
    await withTempDir(async (dir) => {
      const keys = await makeRepo(dir);
      await writeFile(join(dir, "host.key"), `${keys.host}\n`, { mode: 0o644 });
      await runCli(["add", "host/app", "A"], { cwd: dir, home: dir, stdin: "a" });
      const result = await runCli(["pull", "host/app", "--env", "-", "--identity", "host.key"], {
        cwd: dir,
        home: dir,
      });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toContain("is readable by other users");
      expect(result.stdout).toBe("A=a\n");
    });
  });

  it("does not decrypt nested scopes", async () => {
    await withTempDir(async (dir) => {
      const keys = await makeRepo(dir);
      await writeFile(
        join(dir, "agedrop.toml"),
        (await readFile(join(dir, "agedrop.toml"), "utf8")) +
          `\n[scopes.host]\nrecipients = ["owners", "hosts"]\n`,
      );
      await runCli(["add", "host", "TOP"], { cwd: dir, home: dir, stdin: "top" });
      await runCli(["add", "host/app", "NESTED"], { cwd: dir, home: dir, stdin: "nested" });
      const result = await runCli(["pull", "host", "--env", "-"], {
        cwd: dir,
        home: dir,
        env: { AGEDROP_IDENTITY: keys.host },
      });
      expect(result.stdout).toBe("TOP=top\n");
    });
  });
});

describe("agedrop ls", () => {
  it("shows stale secrets, unknown scopes and open requests outside git", async () => {
    await withTempDir(async (dir) => {
      await makeRepo(dir);
      await runCli(["add", "host/app", "API_KEY"], { cwd: dir, home: dir, stdin: "a" });
      await runCli(["add", "other", "TOKEN"], { cwd: dir, home: dir, stdin: "b" });
      await mkdir(join(dir, "requests"));
      await writeFile(join(dir, "requests", "r1.toml"), REQUEST);
      // Drop the host from the scope: API_KEY is now encrypted to a different set.
      await writeFile(
        join(dir, "agedrop.toml"),
        (await readFile(join(dir, "agedrop.toml"), "utf8")).replace(
          `[scopes."host/app"]\nrecipients = ["owners", "hosts"]`,
          `[scopes."host/app"]\nrecipients = ["owners"]`,
        ),
      );

      let result = await runCli(["ls"], { cwd: dir, home: dir });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/^host\/app\/API_KEY\s+stale\s+-\s+-$/m);
      expect(result.stdout).toMatch(/^other\/TOKEN\s+ok/m);
      expect(result.stdout).toMatch(
        /^r1\s+host\/app\/API_KEY\s+2026-11-09\s+agent session\s+needed for the deploy$/m,
      );

      result = await runCli(["ls", "host", "--json"], { cwd: dir, home: dir });
      const json = JSON.parse(result.stdout) as {
        secrets: { secret: string; status: string }[];
        requests: { id: string }[];
      };
      expect(json.secrets.map((s) => [s.secret, s.status])).toEqual([
        ["host/app/API_KEY", "stale"],
      ]);
      expect(json.requests.map((r) => r.id)).toEqual(["r1"]);
    });
  });
});

describe("agedrop check", () => {
  it("passes on a consistent repository", async () => {
    await withTempDir(async (dir) => {
      await makeRepo(dir);
      await runCli(["add", "host/app", "API_KEY"], { cwd: dir, home: dir, stdin: "a" });
      const result = await runCli(["check"], { cwd: dir, home: dir });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toBe("ok: 1 secret in 2 scopes, 2 recipients, 0 open requests\n");
    });
  });

  it("lists every problem and exits 1", async () => {
    await withTempDir(async (dir) => {
      await makeRepo(dir);
      await runCli(["add", "host/app", "API_KEY"], { cwd: dir, home: dir, stdin: "a" });
      await runCli(["add", "other", "TOKEN"], { cwd: dir, home: dir, stdin: "b" });
      const armored = await readFile(join(dir, "secrets/other/TOKEN.age"), "utf8");
      await mkdir(join(dir, "secrets", "gone"));
      await writeFile(join(dir, "secrets", "gone", "X.age"), armored);
      await writeFile(join(dir, "secrets", "other", "Bad-Name.age"), armored);
      await writeFile(join(dir, "secrets", "other", "PLAIN.age"), "not encrypted");
      await writeFile(join(dir, "secrets", "other", ".gitkeep"), "");
      await writeFile(join(dir, "recipients", "notes.txt"), "");
      await writeFile(join(dir, "recipients", "ghost.identity.age"), "not age");
      await mkdir(join(dir, "requests"));
      await writeFile(join(dir, "requests", "r1.toml"), REQUEST.replace("host/app", "nowhere"));
      await writeFile(join(dir, "requests", "r2.toml"), "scope = 1\n");
      const lock = await readFile(join(dir, "agedrop.lock"), "utf8");
      await writeFile(
        join(dir, "agedrop.lock"),
        lock
          .replace(/("host\/app\/API_KEY" = "sha256:)[0-9a-f]{64}/, `$1${"0".repeat(64)}`)
          .replace("[secrets]\n", `[secrets]\n"other/GONE" = "sha256:${"1".repeat(64)}"\n`),
      );

      const result = await runCli(["check"], { cwd: dir, home: dir });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      const lines = result.stderr.trimEnd().split("\n");
      expect(lines).toEqual([
        "agedrop: recipients/notes.txt: unexpected file (expected <name>.pub or <name>.identity.age)",
        "agedrop: recipients/ghost.identity.age: not an ASCII-armored age file",
        "agedrop: recipients/ghost.identity.age: no recipients/ghost.pub next to it",
        `agedrop: agedrop.lock: "other/GONE": its fingerprint has no [sets] entry`,
        `agedrop: agedrop.lock: "host/app/API_KEY": its fingerprint has no [sets] entry`,
        'agedrop: secrets/gone/X.age: scope "gone" is not defined in agedrop.toml',
        expect.stringMatching(/^agedrop: secrets\/host\/app\/API_KEY\.age: stale: /),
        expect.stringMatching(
          /^agedrop: secrets\/other\/Bad-Name\.age: not a valid secrets\/<scope>\/<NAME>\.age path/,
        ),
        "agedrop: secrets/other/PLAIN.age: not an ASCII-armored age file",
        expect.stringMatching(/^agedrop: secrets\/other\/PLAIN\.age: no agedrop\.lock entry/),
        `agedrop: agedrop.lock: "other/GONE" has no secrets/other/GONE.age`,
        `agedrop: requests/r1.toml: scope "nowhere" is not defined in agedrop.toml`,
        `agedrop: requests/r2.toml: "scope" must be a non-empty string`,
        `agedrop: requests/r2.toml: missing "name"`,
        `agedrop: requests/r2.toml: missing "reason"`,
        `agedrop: requests/r2.toml: missing "requested_by"`,
        `agedrop: requests/r2.toml: missing "created"`,
        "17 problems",
      ]);
    });
  });

  it("reports a broken agedrop.toml and a private key in a .pub file without echoing it", async () => {
    await withTempDir(async (dir) => {
      const keys = await makeRepo(dir);
      await writeFile(join(dir, "agedrop.toml"), "version = 1\n[recipients]\nowners = []\n");
      await writeFile(join(dir, "recipients", "host.pub"), `# kind: machine\n${keys.host}\n`);
      const result = await runCli(["check"], { cwd: dir, home: dir });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("agedrop: agedrop.toml: unsupported version 1");
      expect(result.stderr).toContain("agedrop: recipients/host.pub: holds a private key");
      expect(result.stderr).not.toContain(keys.host);
    });
  });
});

describe("readHiddenLine", () => {
  it("reads one line from a terminal without echo, handling backspace", async () => {
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      rawMode: [] as boolean[],
      setRawMode(mode: boolean) {
        this.rawMode.push(mode);
        return this;
      },
    });
    let stderr = "";
    const ctx: Context = {
      cwd: "/",
      home: "/",
      env: {},
      stdin,
      stdout: { write: () => true },
      stderr: { write: (chunk) => (stderr += String(chunk)) },
    };
    const line = readHiddenLine(ctx, "value: ");
    stdin.write("sec");
    stdin.write("x\u007fret\rignored");
    expect(await line).toBe("secret");
    expect(stderr).toBe("value: \n");
    expect(stdin.rawMode).toEqual([true, false]);
  });
});

describe("writeFileAtomic", () => {
  it("replaces with the given mode, or refuses with exclusive", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "f");
      await writeFile(path, "old", { mode: 0o644 });
      await writeFileAtomic(path, "new", { mode: 0o600 });
      expect(await readFile(path, "utf8")).toBe("new");
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      await expect(writeFileAtomic(path, "x", { mode: 0o600, exclusive: true })).rejects.toThrow(
        /EEXIST/,
      );
      expect(await readFile(path, "utf8")).toBe("new");
    });
  });
});

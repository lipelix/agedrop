import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { Context } from "../src/cli/context.js";
import { run as runCommand } from "../src/cli/run.js";
import { decryptSecretText, encryptSecret, formatRecipientFile, parseLock } from "../src/index.js";
import { makeRepo, runCli } from "./cli-helpers.js";
import { throwawayKey, withTempDir } from "./helpers.js";

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

async function fileRequest(dir: string, argv: string[] = []): Promise<string> {
  const result = await runCli(
    ["request", "host/app", "API_KEY", "--reason", "for the deploy", ...argv],
    { cwd: dir, home: dir, env: { AGEDROP_REQUESTED_BY: "test agent" } },
  );
  expect(result.code, result.stderr).toBe(0);
  return result.stdout.trim();
}

describe("agedrop request", () => {
  it("writes a request with no value and prints its id", async () => {
    await withTempDir(async (dir) => {
      await makeRepo(dir);
      const id = await fileRequest(dir, ["--generate", "openssl rand -hex 32"]);
      const text = await readFile(join(dir, "requests", `${id}.toml`), "utf8");
      expect(text).toMatch(
        /^scope = "host\/app"\nname = "API_KEY"\nreason = "for the deploy"\nrequested_by = "test agent"\ncreated = "\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z"\ngenerate = "openssl rand -hex 32"\n$/,
      );
      const result = await runCli(["check"], { cwd: dir, home: dir });
      expect(result.stdout).toContain("1 open request");
    });
  });

  it("rejects bad arguments before writing anything", async () => {
    await withTempDir(async (dir) => {
      await makeRepo(dir);
      for (const [argv, code, message] of [
        [["request", "host/app", "API_KEY"], 2, "missing --reason"],
        [["request", "host/app", "API_KEY", "--reason", " "], 2, "missing --reason"],
        [["request", "host/app", "Api", "--reason", "r"], 2, `invalid secret name "Api"`],
        [["request", "host/app", "API_KEY", "value", "--reason", "r"], 2, "carries no value"],
        [["request", "host/app", "API_KEY", "--reason", "r", "--generate", ""], 2, "--generate"],
        [["request", "nope", "API_KEY", "--reason", "r"], 1, `unknown scope "nope"`],
      ] as const) {
        const result = await runCli([...argv], { cwd: dir, home: dir });
        expect(result.code, argv.join(" ")).toBe(code);
        expect(result.stderr).toContain(message);
      }
      expect(await exists(join(dir, "requests"))).toBe(false);
    });
  });
});

describe("agedrop requests", () => {
  it("filters by scope and says when there are none", async () => {
    await withTempDir(async (dir) => {
      await makeRepo(dir);
      let result = await runCli(["requests"], { cwd: dir, home: dir });
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("no open requests\n");
      const id = await fileRequest(dir);
      result = await runCli(["requests", "host"], { cwd: dir, home: dir });
      expect(result.stdout).toMatch(new RegExp(`^${id}\\s+host/app/API_KEY\\s`, "m"));
      result = await runCli(["requests", "other"], { cwd: dir, home: dir });
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("no open requests in other\n");
      result = await runCli(["requests", "nope"], { cwd: dir, home: dir });
      expect(result.code).toBe(1);
    });
  });
});

describe("agedrop fulfil", () => {
  it("works outside git and with --no-commit", async () => {
    await withTempDir(async (dir) => {
      const keys = await makeRepo(dir);
      const id = await fileRequest(dir);
      const result = await runCli(["fulfil", id], { cwd: dir, home: dir, stdin: "v1" });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toContain("not in a git work tree: nothing committed");
      expect(await exists(join(dir, "requests", `${id}.toml`))).toBe(false);
      const armored = await readFile(join(dir, "secrets/host/app/API_KEY.age"), "utf8");
      expect(await decryptSecretText(armored, [keys.host])).toBe("v1");

      const again = await fileRequest(dir);
      const replaced = await runCli(["fulfil", again, "--no-commit"], {
        cwd: dir,
        home: dir,
        stdin: "v2",
      });
      expect(replaced.code, replaced.stderr).toBe(0);
      expect(replaced.stderr).toContain("replaced secrets/host/app/API_KEY.age");
      expect(replaced.stderr).toContain("not committed (--no-commit)");
    });
  });

  it("fails without writing on a bad id, an empty value or a missing hint", async () => {
    await withTempDir(async (dir) => {
      await makeRepo(dir);
      const id = await fileRequest(dir);
      for (const [argv, stdin, code, message] of [
        [["fulfil"], "", 2, "missing <id>"],
        [["fulfil", "../x"], "", 2, "invalid request id"],
        [["fulfil", "zzzzzzzz"], "", 1, "no open request zzzzzzzz"],
        [["fulfil", id, "value"], "", 2, "never from arguments"],
        [["fulfil", id], "", 1, "empty value"],
        [["fulfil", id, "--generate"], "", 1, "has no generate hint"],
      ] as const) {
        const result = await runCli([...argv], { cwd: dir, home: dir, stdin });
        expect(result.code, argv.join(" ")).toBe(code);
        expect(result.stderr).toContain(message);
      }
      expect(await exists(join(dir, "requests", `${id}.toml`))).toBe(true);
      expect(await exists(join(dir, "secrets"))).toBe(false);
    });
  });

  it("asks before running a generate hint from a terminal", async () => {
    await withTempDir(async (dir) => {
      const keys = await makeRepo(dir);
      const fulfilFromTty = async (id: string, answers: string[]): Promise<string> => {
        const stdin = Object.assign(new PassThrough(), {
          isTTY: true,
          setRawMode: () => stdin,
        });
        let stderr = "";
        const ctx: Context = {
          cwd: dir,
          home: dir,
          env: {},
          stdin,
          stdout: { write: () => true },
          stderr: { write: (chunk) => (stderr += String(chunk)) },
        };
        const done = runCommand(["fulfil", id, "--no-commit"], ctx);
        let prompts = 0;
        for (const answer of answers) {
          await vi.waitFor(() => {
            expect(stderr.split(/\[y\/N\] |value for /).length - 1).toBeGreaterThan(prompts);
          });
          prompts++;
          stdin.write(answer);
        }
        expect(await done, stderr).toBe(0);
        return stderr;
      };
      const read = async (): Promise<string> =>
        decryptSecretText(await readFile(join(dir, "secrets/host/app/API_KEY.age"), "utf8"), [
          keys.owner,
        ]);

      // An env-style value loses the generated trailing newline, as with $(…).
      let id = await fileRequest(dir, ["--generate", "printf 'generated\\n\\n'"]);
      let stderr = await fulfilFromTty(id, ["y\r"]);
      expect(stderr).toContain("generate:     printf 'generated\\n\\n'");
      expect(stderr).not.toContain("ends with a newline");
      expect(stderr).toContain("run the generate command above? [y/N] y\n");
      expect(await read()).toBe("generated");

      id = await fileRequest(dir, ["--generate", "printf generated"]);
      stderr = await fulfilFromTty(id, ["n\r", "typed\r"]);
      expect(stderr).not.toContain("typed");
      expect(await read()).toBe("typed");
    });
  });
});

describe("agedrop rekey", () => {
  async function setup(dir: string) {
    const keys = await makeRepo(dir);
    await writeFile(join(dir, "owner.key"), `${keys.owner}\n`, { mode: 0o600 });
    for (const [scope, name] of [
      ["host/app", "API_KEY"],
      ["host/app", "OTHER_KEY"],
      ["other", "TOKEN"],
    ] as const) {
      const result = await runCli(["add", scope, name], {
        cwd: dir,
        home: dir,
        stdin: `${name}-value`,
      });
      expect(result.code, result.stderr).toBe(0);
    }
    return keys;
  }
  const rekey = (dir: string, ...argv: string[]) =>
    runCli(["rekey", "--identity", "owner.key", ...argv], { cwd: dir, home: dir });

  it("lists a replaced key and unknown previous recipients for rotation", async () => {
    await withTempDir(async (dir) => {
      const keys = await setup(dir);
      const oldHost = (await readFile(join(dir, "recipients/host.pub"), "utf8")).trim();
      const newHost = await throwawayKey();
      await writeFile(
        join(dir, "recipients", "host.pub"),
        formatRecipientFile({ kind: "machine", recipient: newHost.recipient }),
      );
      const lock = await readFile(join(dir, "agedrop.lock"), "utf8");
      await writeFile(
        join(dir, "agedrop.lock"),
        lock.replace(/^"host\/app\/OTHER_KEY" = .*\n/m, ""),
      );

      const result = await rekey(dir, "host");
      expect(result.code, result.stderr).toBe(0);
      const oldKey = oldHost.split("\n").at(-1) ?? "";
      expect(result.stdout).toBe(
        `rotate host/app/API_KEY: no longer for host (${oldKey})\n` +
          `rotate host/app/OTHER_KEY: previous recipients unknown (no agedrop.lock entry)\n`,
      );
      const armored = await readFile(join(dir, "secrets/host/app/API_KEY.age"), "utf8");
      expect(await decryptSecretText(armored, [newHost.identity])).toBe("API_KEY-value");
      await expect(decryptSecretText(armored, [keys.host])).rejects.toThrow();
    });
  });

  it("re-encrypts everything with --all without asking for rotation", async () => {
    await withTempDir(async (dir) => {
      await setup(dir);
      const before = await readFile(join(dir, "secrets/other/TOKEN.age"), "utf8");
      const result = await rekey(dir, "--all");
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("rekeyed 3 secrets");
      expect(await readFile(join(dir, "secrets/other/TOKEN.age"), "utf8")).not.toBe(before);
      expect((await runCli(["check"], { cwd: dir, home: dir })).code).toBe(0);
    });
  });

  it("skips a secret the owner cannot decrypt and exits 1", async () => {
    await withTempDir(async (dir) => {
      await setup(dir);
      const stranger = await throwawayKey();
      await writeFile(
        join(dir, "secrets/other/TOKEN.age"),
        await encryptSecret("x", [stranger.recipient]),
      );
      const lock = await readFile(join(dir, "agedrop.lock"), "utf8");
      const fp = parseLock(lock).secrets.get("other/TOKEN") ?? "";
      await writeFile(
        join(dir, "agedrop.lock"),
        lock.replace(`"other/TOKEN" = "${fp}"`, `"other/TOKEN" = "sha256:${"0".repeat(64)}"`),
      );
      const result = await rekey(dir, "--all");
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "agedrop: secrets/other/TOKEN.age: cannot decrypt with the owner identity, skipped",
      );
      expect(result.stderr).toContain("rekeyed 2 secrets");
    });
  });

  it("rejects an unknown scope and extra arguments", async () => {
    await withTempDir(async (dir) => {
      await setup(dir);
      expect((await rekey(dir, "nope")).code).toBe(1);
      expect((await rekey(dir, "other", "extra")).code).toBe(2);
    });
  });
});

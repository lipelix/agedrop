import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLI, envFor, makeRepo, runCli, spawnCli } from "./cli-helpers.js";
import { withTempDir } from "./helpers.js";

const TOKEN = "tok_9f8e7d6c5b4a";
const URL_VALUE = "postgres://app:p@ss w0rd@db/app";

/** A repository whose scope "host/app" holds TOKEN, DATABASE_URL and a 3-byte PIN. */
async function repoWithValues(dir: string, redactScope = false): Promise<Record<string, string>> {
  const keys = await makeRepo(dir);
  if (redactScope) {
    const config = await readFile(join(dir, "agedrop.toml"), "utf8");
    await writeFile(
      join(dir, "agedrop.toml"),
      config.replace(
        `[scopes."host/app"]\nrecipients = ["owners", "hosts"]`,
        `[scopes."host/app"]\nrecipients = ["owners", "hosts"]\nredact = true`,
      ),
    );
  }
  for (const [name, value] of [
    ["TOKEN", TOKEN],
    ["DATABASE_URL", URL_VALUE],
    ["PIN", "123"],
  ] as const) {
    const result = await runCli(["add", "host/app", name], { cwd: dir, home: dir, stdin: value });
    expect(result.code, result.stderr).toBe(0);
  }
  return { AGEDROP_IDENTITY: keys.host, PATH: process.env.PATH ?? "" };
}

/** A node script that prints the values in several forms on stdout and stderr, then exits with 3. */
const LEAKY = `
const { TOKEN, DATABASE_URL, PIN } = process.env;
console.log("token", TOKEN, "pin", PIN);
console.log("url", encodeURIComponent(DATABASE_URL));
console.log(JSON.stringify({ url: DATABASE_URL }));
console.log("basic", Buffer.from("app:" + TOKEN).toString("base64"));
process.stderr.write("error: cannot connect to " + DATABASE_URL + "\\n");
process.exit(3);
`;

describe("agedrop exec --redact", () => {
  it("masks values in stdout and stderr and keeps the exit code", async () => {
    await withTempDir(async (dir) => {
      const env = await repoWithValues(dir);
      const result = await runCli(
        ["exec", "host/app", "--redact", "--", process.execPath, "-e", LEAKY],
        { cwd: dir, home: dir, env },
      );
      expect(result.code).toBe(3);
      for (const leaked of [TOKEN, URL_VALUE, encodeURIComponent(URL_VALUE), "p@ss w0rd"]) {
        expect(result.stdout + result.stderr).not.toContain(leaked);
      }
      expect(result.stdout).toContain("token [REDACTED:TOKEN] pin 123\n");
      expect(result.stdout).toContain("url [REDACTED:DATABASE_URL]\n");
      expect(result.stdout).toContain('{"url":"[REDACTED:DATABASE_URL]"}\n');
      expect(result.stdout).toMatch(/^basic \w{0,6}\[REDACTED:TOKEN\]\S{0,3}$/m);
      expect(result.stderr).toContain("agedrop: not redacted, shorter than 6 bytes: PIN\n");
      expect(result.stderr).toContain("error: cannot connect to [REDACTED:DATABASE_URL]\n");
    });
  });

  it("leaves output alone without --redact", async () => {
    await withTempDir(async (dir) => {
      const env = await repoWithValues(dir);
      const result = await spawnCli(["exec", "host/app", "--", process.execPath, "-e", LEAKY], {
        cwd: dir,
        env: envFor(dir, env),
      });
      expect(result.code).toBe(3);
      expect(result.stdout).toContain(`token ${TOKEN} pin 123\n`);
      expect(result.stderr).toBe(`error: cannot connect to ${URL_VALUE}\n`);
    });
  });

  it("always redacts in a scope with redact = true and refuses --no-redact", async () => {
    await withTempDir(async (dir) => {
      const env = await repoWithValues(dir, true);
      let result = await runCli(
        ["exec", "host/app", "--", process.execPath, "-e", "console.log(process.env.TOKEN)"],
        { cwd: dir, home: dir, env },
      );
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toBe("[REDACTED:TOKEN]\n");

      // Refused before any identity is needed.
      result = await runCli(["exec", "host/app", "--no-redact", "--", "true"], {
        cwd: dir,
        home: dir,
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toBe(
        `agedrop: scope "host/app" has redact = true in agedrop.toml, so --no-redact is refused\n`,
      );

      result = await runCli(["exec", "host/app", "--redact", "--no-redact", "--", "true"], {
        cwd: dir,
        home: dir,
      });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("--redact and --no-redact exclude each other");
    });
  });

  it("masks values in large output written in many chunks", async () => {
    await withTempDir(async (dir) => {
      const env = await repoWithValues(dir);
      const script = `
        const filler = "x".repeat(997);
        for (let i = 0; i < 2000; i++) process.stdout.write(filler + process.env.TOKEN);
      `;
      const result = await runCli(
        ["exec", "host/app", "--redact", "--", process.execPath, "-e", script],
        { cwd: dir, home: dir, env },
      );
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).not.toContain(TOKEN.slice(0, 6));
      expect(result.stdout).toBe(`${"x".repeat(997)}[REDACTED:TOKEN]`.repeat(2000));
    });
  });

  it("exits with 128 + the signal's number when a signal ends the command", async () => {
    await withTempDir(async (dir) => {
      const env = await repoWithValues(dir);
      const result = await runCli(
        [
          "exec",
          "host/app",
          "--redact",
          "--",
          process.execPath,
          "-e",
          "console.log(process.env.TOKEN); process.kill(process.pid, 'SIGKILL')",
        ],
        { cwd: dir, home: dir, env },
      );
      expect(result.code).toBe(128 + 9);
      expect(result.stdout).toBe("[REDACTED:TOKEN]\n");
    });
  });

  it("passes SIGTERM on to the command and exits like it", { timeout: 60_000 }, async () => {
    await withTempDir(async (dir) => {
      const env = await repoWithValues(dir);
      const script = `
        process.on("SIGTERM", () => { console.log("got SIGTERM with", process.env.TOKEN); process.exit(42); });
        console.log("ready");
        setInterval(() => {}, 1000);
      `;
      const child = spawn(
        process.execPath,
        [CLI, "exec", "host/app", "--redact", "--", process.execPath, "-e", script],
        { cwd: dir, env: envFor(dir, env), stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      const code = await new Promise<number | null>((resolve) => {
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
          if (stdout.includes("ready\n")) child.kill("SIGTERM");
        });
        child.on("close", resolve);
      });
      expect(code, stderr).toBe(42);
      expect(stdout).toBe("ready\ngot SIGTERM with [REDACTED:TOKEN]\n");
    });
  });
});

describe("agedrop exec --redact into a closed pipe", () => {
  it("closes the command's pipe when the reader goes away", { timeout: 60_000 }, async () => {
    await withTempDir(async (dir) => {
      const env = await repoWithValues(dir);
      const child = spawn(
        process.execPath,
        [CLI, "exec", "host/app", "--redact", "--", "sh", "-c", 'yes "$TOKEN"'],
        { cwd: dir, env: envFor(dir, env), stdio: ["ignore", "pipe", "pipe"] },
      );
      let first = "";
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.stdout.once("data", (chunk: Buffer) => {
        first = chunk.toString();
        child.stdout.destroy(); // like `| head -1`
      });
      const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
      expect(first).toMatch(/^\[REDACTED:TOKEN\]\n/);
      // yes dies of SIGPIPE, as it would without redaction; agedrop reports no error of its own.
      expect(stderr).toBe("agedrop: not redacted, shorter than 6 bytes: PIN\n");
      expect(code).toBe(128 + 13);
    });
  });
});

describe("short values in scopes that redact", () => {
  it("ls and check warn about them without failing", async () => {
    await withTempDir(async (dir) => {
      await repoWithValues(dir, true);
      let result = await runCli(["ls"], { cwd: dir, home: dir });
      expect(result.code, result.stderr).toBe(0);
      const warning =
        "agedrop: secrets/host/app/PIN.age: warning: shorter than 6 bytes, so exec --redact cannot mask it\n";
      expect(result.stderr).toBe(warning);
      result = await runCli(["check"], { cwd: dir, home: dir });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toBe(warning);
      expect(result.stdout).toMatch(/^ok: 3 secrets/);
    });
  });

  it("are not warned about in scopes that do not redact", async () => {
    await withTempDir(async (dir) => {
      await repoWithValues(dir);
      expect((await runCli(["ls"], { cwd: dir, home: dir })).stderr).toBe("");
      expect((await runCli(["check"], { cwd: dir, home: dir })).stderr).toBe("");
    });
  });
});

import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLI, envFor, makeRepo, spawnCli } from "./cli-helpers.js";
import { run, throwawayKey, withTempDir } from "./helpers.js";

/** A git work tree in `<dir>/repo` with a clean environment, and a `git` that runs in it. */
async function gitRepo(dir: string) {
  const home = join(dir, "home");
  const repo = join(dir, "repo");
  await mkdir(home);
  await mkdir(repo);
  // The hook finds agedrop on PATH, as it would after npm install --global.
  const bin = join(dir, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "agedrop"), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`);
  await chmod(join(bin, "agedrop"), 0o755);
  const env = envFor(home, { PATH: `${bin}:${process.env.PATH ?? ""}` });
  const git = async (...args: string[]) => (await run("git", args, { cwd: repo, env })).stdout;
  await git("init", "-q", "-b", "main");
  const cli = (argv: string[], options: { cwd?: string; stdin?: string } = {}) =>
    spawnCli(argv, { cwd: options.cwd ?? repo, env, stdin: options.stdin ?? "" });
  return { home, repo, env, git, cli };
}

/** Runs git and returns its exit code and stderr instead of throwing. */
async function tryGit(cwd: string, env: Record<string, string>, ...args: string[]) {
  try {
    await run("git", args, { cwd, env });
    return { code: 0, stderr: "" };
  } catch (error) {
    const failure = error as { code: number; stderr: string };
    return { code: failure.code, stderr: failure.stderr };
  }
}

describe("agedrop check --staged", () => {
  it("refuses plaintext under secrets/, private keys and unignored env files", async () => {
    await withTempDir(async (dir) => {
      const { repo, git, cli } = await gitRepo(dir);
      await makeRepo(repo);
      expect((await cli(["add", "host/app", "API_KEY"], { stdin: "real-value" })).code).toBe(0);
      const key = (await throwawayKey()).identity;
      await mkdir(join(repo, "secrets", "other"), { recursive: true });
      await writeFile(join(repo, "secrets", "other", "TOKEN.age"), "plain-token-value\n");
      await writeFile(join(repo, "secrets", "other", ".gitkeep"), "");
      await writeFile(join(repo, "notes.txt"), `my key: ${key}\n`);
      await writeFile(join(repo, "docs.md"), "an identity starts with AGE-SECRET-KEY-1…\n");
      await writeFile(join(repo, "recipients", "owner.identity.age"), `${key}\n`);
      await writeFile(join(repo, ".env"), "API_KEY=real-value\n");
      await mkdir(join(repo, "app"));
      await writeFile(join(repo, "app", ".env.local"), "API_KEY=real-value\n");
      await writeFile(join(repo, "app", ".env.example"), "API_KEY=\n");
      await git("add", "-A");

      let result = await cli(["check", "--staged"]);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr.trimEnd().split("\n")).toEqual([
        expect.stringMatching(/^agedrop: \.env: an env file, .* no ignore rule covers it/),
        expect.stringMatching(/^agedrop: app\/\.env\.local: an env file/),
        "agedrop: notes.txt: holds an age private key (AGE-SECRET-KEY-…)",
        expect.stringMatching(
          /^agedrop: secrets\/other\/TOKEN\.age: not an ASCII-armored age file: plaintext/,
        ),
        expect.stringMatching(/^4 problems: /),
      ]);
      expect(result.stderr).not.toContain(key);
      expect(result.stderr).not.toContain("plain-token-value");

      // An ignored env file was added with git add -f, on purpose.
      await writeFile(join(repo, ".gitignore"), ".env\n.env.*\n");
      await git("rm", "-q", "--cached", "secrets/other/TOKEN.age", "notes.txt");
      await git("add", ".gitignore");
      result = await cli(["check", "--staged"]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/^ok: \d+ staged files\n$/);
    });
  });

  it("finds decryptable values with --values, never printing them", async () => {
    await withTempDir(async (dir) => {
      const { repo, git, cli } = await gitRepo(dir);
      const keys = await makeRepo(repo);
      const identity = join(dir, "host.identity");
      await writeFile(identity, `${keys.host}\n`, { mode: 0o600 });
      const value = "postgres://app:hunter2@db/app";
      expect((await cli(["add", "host/app", "DATABASE_URL"], { stdin: value })).code).toBe(0);
      expect((await cli(["add", "host/app", "SHORT"], { stdin: "abc" })).code).toBe(0);
      expect((await cli(["add", "other", "TOKEN"], { stdin: "owner-only-token" })).code).toBe(0);
      await git("add", "-A");
      await git("commit", "-q", "-m", "secrets");

      await writeFile(join(repo, "config.yml"), `url: ${value}\n`);
      await writeFile(
        join(repo, "auth.log"),
        `Authorization: Basic ${Buffer.from(`user:${value}`).toString("base64")}\n`,
      );
      await writeFile(join(repo, "clean.txt"), "nothing here\n");
      await git("add", "-A");

      expect((await cli(["check", "--staged"])).code).toBe(0);
      const result = await cli(["check", "--staged", "--values", "--identity", identity]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "agedrop: auth.log: holds the value of host/app/DATABASE_URL",
      );
      expect(result.stderr).toContain(
        "agedrop: config.yml: holds the value of host/app/DATABASE_URL",
      );
      expect(result.stderr).toContain("not looking for values under 6 bytes: host/app/SHORT");
      expect(result.stderr).toContain("looking for 2 values this identity decrypts, of 3 secrets");
      expect(result.stderr).not.toContain("hunter2");

      const stranger = join(dir, "stranger.identity");
      await writeFile(stranger, `${(await throwawayKey()).identity}\n`, { mode: 0o600 });
      const none = await cli(["check", "--staged", "--values", "--identity", stranger]);
      expect(none.code).toBe(1);
      expect(none.stderr).toContain("decrypts none of the 3 secrets");

      expect((await cli(["check", "--values"])).code).toBe(2);
      expect((await cli(["check", "--staged", "--since", "HEAD"])).code).toBe(2);
    });
  });

  it("checks every commit since a revision with --since", async () => {
    await withTempDir(async (dir) => {
      const { repo, git, cli } = await gitRepo(dir);
      await makeRepo(repo);
      await git("add", "-A");
      await git("commit", "-q", "-m", "base");
      const base = (await git("rev-parse", "HEAD")).trim();
      await writeFile(join(repo, ".env"), "TOKEN=plain\n");
      await git("add", ".env");
      await git("commit", "-q", "-m", "oops");
      await git("rm", "-q", ".env");
      await git("commit", "-q", "-m", "remove it again");

      // The file is gone at HEAD, but history has it.
      let result = await cli(["check", "--since", base]);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/^agedrop: \.env: an env file/m);
      result = await cli(["check", "--since", "0".repeat(40)]);
      expect(result.code).toBe(1);
      result = await cli(["check", "--since", "HEAD"]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toBe("ok: 0 file versions since HEAD\n");
      result = await cli(["check", "--since", "no-such-rev"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`--since "no-such-rev" is not a commit`);
    });
  });

  it("fails outside a git work tree", async () => {
    await withTempDir(async (dir) => {
      await makeRepo(dir);
      const result = await spawnCli(["check", "--staged"], { cwd: dir, env: envFor(dir) });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("is not in a git work tree");
    });
  });
});

describe("agedrop protect", () => {
  it("installs a hook that blocks a commit with plaintext", async () => {
    await withTempDir(async (dir) => {
      const { repo, env, git, cli } = await gitRepo(dir);
      await makeRepo(repo);
      let result = await cli(["protect"]);
      expect(result.code, result.stderr).toBe(0);
      const hook = join(repo, ".git", "hooks", "pre-commit");
      expect(result.stderr).toMatch(/^installed \/\S*\/\.git\/hooks\/pre-commit: /m);
      expect((await stat(hook)).mode & 0o111).not.toBe(0);
      expect(await readFile(hook, "utf8")).toMatch(/^exec agedrop check --staged$/m);
      expect(await readFile(join(repo, ".gitignore"), "utf8")).toBe(
        "# agedrop: decrypted values and identities\n.env\n.env.*\n!.env.example\nidentity\n*.identity\n",
      );

      // The first commit, before HEAD exists, is checked too.
      await mkdir(join(repo, "secrets", "host", "app"), { recursive: true });
      await writeFile(join(repo, "secrets", "host", "app", "API_KEY.age"), "plaintext\n");
      await git("add", "-A");
      const blocked = await tryGit(repo, env, "commit", "-q", "-m", "secrets");
      expect(blocked.code).not.toBe(0);
      expect(blocked.stderr).toContain(
        "agedrop: secrets/host/app/API_KEY.age: not an ASCII-armored age file",
      );
      await expect(git("rev-parse", "--verify", "-q", "HEAD")).rejects.toThrow();

      await git("rm", "-q", "--cached", "secrets/host/app/API_KEY.age");
      expect((await tryGit(repo, env, "commit", "-q", "-m", "setup")).code).toBe(0);

      // Rerunning rewrites its own hook and leaves .gitignore alone.
      result = await cli(["protect"]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toMatch(/^updated \/\S*\/\.git\/hooks\/pre-commit: /m);
      expect(result.stderr).not.toContain(".gitignore");
    });
  });

  it("never replaces another hook without --force", async () => {
    await withTempDir(async (dir) => {
      const { repo, cli } = await gitRepo(dir);
      await makeRepo(repo);
      const hook = join(repo, ".git", "hooks", "pre-commit");
      await writeFile(hook, "#!/bin/sh\nnpm test\n", { mode: 0o755 });
      let result = await cli(["protect"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("agedrop did not write it");
      expect(await readFile(hook, "utf8")).toBe("#!/bin/sh\nnpm test\n");
      result = await cli(["protect", "--force"]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toMatch(/^replaced \/\S*\/\.git\/hooks\/pre-commit: /m);
      expect(await readFile(hook, "utf8")).toContain("agedrop check --staged");
    });
  });

  it("follows core.hooksPath and passes --repo for an agedrop subdirectory", async () => {
    await withTempDir(async (dir) => {
      const { repo, env, git, cli } = await gitRepo(dir);
      await git("config", "core.hooksPath", ".githooks");
      const sub = join(repo, "ops dir");
      await mkdir(sub);
      await makeRepo(sub);
      const result = await cli(["protect"], { cwd: sub });
      expect(result.code, result.stderr).toBe(0);
      const hook = join(repo, ".githooks", "pre-commit");
      expect(await readFile(hook, "utf8")).toMatch(
        /^exec agedrop check --staged --repo 'ops dir'$/m,
      );
      expect(await readFile(join(sub, ".gitignore"), "utf8")).toContain(".env.*\n");

      // The hook runs from the work tree's top and finds the agedrop directory.
      await writeFile(join(repo, "README"), "hello\n");
      await git("add", "-A");
      expect((await tryGit(repo, env, "commit", "-q", "-m", "ok")).code).toBe(0);
      await writeFile(join(repo, "leak.txt"), `${(await throwawayKey()).identity}\n`);
      await git("add", "leak.txt");
      const blocked = await tryGit(repo, env, "commit", "-q", "-m", "leak");
      expect(blocked.code).not.toBe(0);
      expect(blocked.stderr).toContain("agedrop: leak.txt: holds an age private key");
    });
  });

  it("fails outside a git work tree", async () => {
    await withTempDir(async (dir) => {
      await makeRepo(dir);
      const result = await spawnCli(["protect"], { cwd: dir, env: envFor(dir) });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("not in a git work tree");
    });
  });
});

describe("agedrop init and pull keep plaintext out of git", () => {
  it("init adds .gitignore lines and both CI workflows, never overwriting one", async () => {
    await withTempDir(async (dir) => {
      const { repo, cli } = await gitRepo(dir);
      await writeFile(join(repo, ".gitignore"), "node_modules/\n.env");
      let result = await cli(["init", "--owner", "me"]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toContain("then: agedrop protect");
      expect(await readFile(join(repo, ".gitignore"), "utf8")).toBe(
        "node_modules/\n.env\n\n# agedrop: decrypted values and identities\n.env.*\n!.env.example\nidentity\n*.identity\n",
      );

      const check = join(repo, ".github", "workflows", "agedrop-check.yml");
      const requests = join(repo, ".github", "workflows", "agedrop-requests.yml");
      await mkdir(join(repo, ".github", "workflows"), { recursive: true });
      await writeFile(requests, "# mine\n");
      result = await cli(["init", "--ci", "github"]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toContain("agedrop-requests.yml already exists: left as it is");
      expect(await readFile(requests, "utf8")).toBe("# mine\n");
      const workflow = await readFile(check, "utf8");
      expect(workflow).toMatch(/^ {2}pull_request:$/m);
      expect(workflow).toMatch(/npx --yes agedrop@\d+\.\d+\.\d+ check --since "\$BASE"$/m);

      result = await cli(["init", "--ci", "github"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("already exist");
    });
  });

  it("pull adds what it writes to .gitignore and warns about tracked files", async () => {
    await withTempDir(async (dir) => {
      const { repo, git, cli } = await gitRepo(dir);
      const keys = await makeRepo(repo);
      const identity = join(dir, "host.identity");
      await writeFile(identity, `${keys.host}\n`, { mode: 0o600 });
      expect((await cli(["add", "host/app", "API_KEY"], { stdin: "value-1" })).code).toBe(0);
      expect((await cli(["add", "host/app", "tls.crt"], { stdin: "cert\n" })).code).toBe(0);

      let result = await cli(["pull", "host/app", "--to", "out", "--identity", identity]);
      expect(result.code, result.stderr).toBe(0);
      expect(await readFile(join(repo, "out", ".gitignore"), "utf8")).toBe(
        "# agedrop pull: decrypted values, never commit them\n/API_KEY\n/tls.crt\n",
      );
      result = await cli(["pull", "host/app", "--env", "app.env", "--identity", identity]);
      expect(result.code, result.stderr).toBe(0);
      expect(await readFile(join(repo, ".gitignore"), "utf8")).toContain("/app.env\n");
      await git("add", "-A");
      expect(await git("diff", "--cached", "--name-only")).not.toMatch(/API_KEY$|app\.env/m);

      // Pulled again: nothing new to ignore. A tracked file gets a warning.
      await git("add", "-f", "app.env");
      result = await cli(["pull", "host/app", "--env", "app.env", "--identity", identity]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).not.toContain(".gitignore");
      expect(result.stderr).toContain("warning: git tracks app.env");

      // Outside git nothing is added.
      const outside = join(dir, "outside");
      result = await cli(["pull", "host/app", "--to", outside, "--identity", identity]);
      expect(result.code, result.stderr).toBe(0);
      await expect(stat(join(outside, ".gitignore"))).rejects.toThrow();
    });
  });
});

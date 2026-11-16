import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { envFor, spawnCli } from "./cli-helpers.js";
import { run, withTempDir } from "./helpers.js";

describe("agedrop CLI end to end", () => {
  it(
    "runs init → keygen → add → ls → check → pull → exec in a git repo",
    { timeout: 120_000 },
    async () => {
      await withTempDir(async (dir) => {
        const home = join(dir, "home");
        const repo = join(dir, "repo");
        await mkdir(home);
        await mkdir(repo);
        const env = envFor(home);
        await run("git", ["init", "-q"], { cwd: repo, env });

        // init
        let result = await spawnCli(["init", "--owner", "owner"], { cwd: repo, env });
        expect(result.code, result.stderr).toBe(0);

        // keygen: the owner's identity goes to ~/.config/agedrop/identity, a CI key to stdout.
        result = await spawnCli(["keygen", "owner", "--kind", "owner"], { cwd: repo, env });
        expect(result.code, result.stderr).toBe(0);
        const ownerIdentityPath = join(home, ".config", "agedrop", "identity");
        expect((await stat(ownerIdentityPath)).mode & 0o777).toBe(0o600);
        expect(result.stdout).toMatch(/^age1[a-z0-9]+\n$/);
        // Node's experimental X25519 notice is not shown to CLI users.
        expect(result.stderr).not.toContain("ExperimentalWarning");

        result = await spawnCli(["keygen", "ci", "--kind", "ci", "--out", "-"], { cwd: repo, env });
        expect(result.code, result.stderr).toBe(0);
        const ciIdentity = result.stdout;
        expect(ciIdentity).toMatch(/^AGE-SECRET-KEY-1/m);
        expect(await readFile(join(repo, "recipients", "ci.pub"), "utf8")).toMatch(/^# kind: ci$/m);

        // Give the CI key a group and a scope (editing agedrop.toml is the owner's job).
        await writeFile(
          join(repo, "agedrop.toml"),
          `version = 0\n\n[recipients]\nowners = ["owner"]\nci = ["ci"]\n\n[scopes."ci/deploy"]\nrecipients = ["owners", "ci"]\n`,
        );

        // add: values come from stdin as exact bytes.
        const multiline = "line one\nline 'two' $HOME";
        for (const [name, value] of [
          ["API_TOKEN", "s3cret-token"],
          ["MULTILINE", multiline],
          ["deploy_key", "-----BEGIN KEY-----\nabc\n-----END KEY-----\n"],
        ] as const) {
          result = await spawnCli(["add", "ci/deploy", name], { cwd: repo, env, stdin: value });
          expect(result.code, result.stderr).toBe(0);
          expect(result.stdout).toBe("");
          expect(result.stderr).not.toContain(value);
        }
        const armored = await readFile(
          join(repo, "secrets", "ci", "deploy", "API_TOKEN.age"),
          "utf8",
        );
        expect(armored).toMatch(/^-----BEGIN AGE ENCRYPTED FILE-----/);
        expect(armored).not.toContain("s3cret-token");
        await run("git", ["add", "-A"], { cwd: repo, env });
        await run("git", ["commit", "-q", "-m", "add secrets"], { cwd: repo, env });

        // Every file decrypts with the stock age CLI.
        const decrypted = await run(
          "age",
          ["-d", "-i", ownerIdentityPath, "secrets/ci/deploy/API_TOKEN.age"],
          {
            cwd: repo,
            env,
          },
        );
        expect(decrypted.stdout).toBe("s3cret-token");

        // ls: last change from git, status from agedrop.lock; never values.
        result = await spawnCli(["ls"], { cwd: repo, env });
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toMatch(
          /^ci\/deploy\/API_TOKEN\s+ok\s+\d{4}-\d{2}-\d{2}\s+Test Author$/m,
        );
        expect(result.stdout).toMatch(/^ci\/deploy\/deploy_key\s+ok/m);
        expect(result.stdout).not.toContain("s3cret-token");

        // check
        result = await spawnCli(["check"], { cwd: repo, env });
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toBe("ok: 3 secrets in 1 scope, 2 recipients, 0 open requests\n");

        // pull with the CI identity from AGEDROP_IDENTITY, from a subdirectory of the repo.
        const ciEnv = envFor(home, { AGEDROP_IDENTITY: ciIdentity, HOME: join(dir, "nohome") });
        await mkdir(join(repo, "sub"));
        const out = join(dir, "out");
        result = await spawnCli(["pull", "ci/deploy", "--to", out], {
          cwd: join(repo, "sub"),
          env: ciEnv,
        });
        expect(result.code, result.stderr).toBe(0);
        expect(await readFile(join(out, "API_TOKEN"), "utf8")).toBe("s3cret-token");
        expect(await readFile(join(out, "MULTILINE"), "utf8")).toBe(multiline);
        expect(await readFile(join(out, "deploy_key"), "utf8")).toContain("abc\n");
        for (const name of ["API_TOKEN", "MULTILINE", "deploy_key"]) {
          expect((await stat(join(out, name))).mode & 0o777).toBe(0o600);
        }

        const envFile = join(dir, "app.env");
        result = await spawnCli(["pull", "ci/deploy", "--env", envFile], { cwd: repo, env: ciEnv });
        expect(result.code, result.stderr).toBe(0);
        expect(result.stderr).toContain("skipped file-style secrets (use --to <dir>): deploy_key");
        expect(await readFile(envFile, "utf8")).toBe(
          `API_TOKEN=s3cret-token\nMULTILINE="line one\\nline 'two' \\$HOME"\n`,
        );
        expect((await stat(envFile)).mode & 0o777).toBe(0o600);

        result = await spawnCli(["pull", "ci/deploy", "API_TOKEN", "--to", "-"], {
          cwd: repo,
          env: ciEnv,
        });
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toBe("s3cret-token");

        // exec: values only in the child's environment; its exit code passes through.
        result = await spawnCli(
          [
            "exec",
            "ci/deploy",
            "--",
            process.execPath,
            "-e",
            "process.stdout.write(process.env.API_TOKEN + '|' + process.env.MULTILINE); process.exit(7)",
          ],
          { cwd: repo, env: ciEnv },
        );
        expect(result.code).toBe(7);
        expect(result.stdout).toBe(`s3cret-token|${multiline}`);
      });
    },
  );

  it(
    "fails clearly on a missing identity, a wrong scope and an unknown recipient",
    { timeout: 120_000 },
    async () => {
      await withTempDir(async (dir) => {
        const env = envFor(dir);
        let result = await spawnCli(["init", "--owner", "owner"], { cwd: dir, env });
        expect(result.code, result.stderr).toBe(0);
        result = await spawnCli(["keygen", "owner", "--kind", "owner", "--out", "owner.key"], {
          cwd: dir,
          env,
        });
        expect(result.code, result.stderr).toBe(0);
        await writeFile(
          join(dir, "agedrop.toml"),
          `version = 0\n[recipients]\nowners = ["owner"]\n[scopes.app]\nrecipients = ["owners"]\n`,
        );
        result = await spawnCli(["add", "app", "TOKEN"], { cwd: dir, env, stdin: "value" });
        expect(result.code, result.stderr).toBe(0);

        // Missing identity: no --identity, no AGEDROP_IDENTITY, no ~/.config/agedrop/identity.
        result = await spawnCli(["pull", "app", "--env", "-"], { cwd: dir, env });
        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(
          /^agedrop: no identity: pass --identity <file>, set AGEDROP_IDENTITY/,
        );

        // An empty AGEDROP_IDENTITY, as CI gives for a missing secret.
        result = await spawnCli(["exec", "app", "--", "true"], {
          cwd: dir,
          env: envFor(dir, { AGEDROP_IDENTITY: "" }),
        });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("AGEDROP_IDENTITY is set but empty");

        // Wrong scope.
        for (const argv of [
          ["add", "nope", "TOKEN"],
          ["pull", "nope", "--env", "-", "--identity", "owner.key"],
          ["exec", "nope", "--", "true"],
          ["ls", "nope"],
        ]) {
          result = await spawnCli(argv, { cwd: dir, env, stdin: "value" });
          expect(result.code, argv.join(" ")).toBe(1);
          expect(result.stderr).toBe(`agedrop: unknown scope "nope": agedrop.toml defines "app"\n`);
        }

        // A command that fails before reading stdin: the unread input must not end in EPIPE.
        result = await spawnCli(["add", "nope", "TOKEN"], {
          cwd: dir,
          env,
          stdin: "x".repeat(1_000_000),
        });
        expect(result.code).toBe(1);
        expect(result.stderr).toBe(`agedrop: unknown scope "nope": agedrop.toml defines "app"\n`);

        // An identity that is not a recipient.
        result = await spawnCli(["keygen", "other", "--out", "other.key"], { cwd: dir, env });
        expect(result.code, result.stderr).toBe(0);
        result = await spawnCli(["pull", "app", "--env", "-", "--identity", "other.key"], {
          cwd: dir,
          env,
        });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain(
          "secrets/app/TOKEN.age: cannot decrypt with the identity from",
        );

        // Unknown recipient: a group names someone without recipients/<name>.pub.
        await writeFile(
          join(dir, "agedrop.toml"),
          `version = 0\n[recipients]\nowners = ["owner", "ghost"]\n[scopes.app]\nrecipients = ["owners"]\n`,
        );
        for (const argv of [["add", "app", "TOKEN"], ["ls"], ["check"]]) {
          result = await spawnCli(argv, { cwd: dir, env, stdin: "value" });
          expect(result.code, argv.join(" ")).toBe(1);
          expect(result.stderr).toContain(
            `agedrop: agedrop.toml: recipients.owners: "ghost" has no recipients/ghost.pub`,
          );
        }
      });
    },
  );
});

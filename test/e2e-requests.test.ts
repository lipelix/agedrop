import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { envFor, type Result, spawnCli } from "./cli-helpers.js";
import { run, withTempDir } from "./helpers.js";

const CONFIG = `version = 0

[recipients]
owners = ["owner"]
hosts = ["host"]

[scopes."host/app"]
recipients = ["owners", "hosts"]
`;

async function git(cwd: string, env: Record<string, string>, ...args: string[]): Promise<string> {
  return (await run("git", args, { cwd, env })).stdout;
}

describe("requests end to end", () => {
  it(
    "request (agent) → fulfil (human) → pull (host), and the agent never sees the value",
    { timeout: 120_000 },
    async () => {
      await withTempDir(async (dir) => {
        const origin = join(dir, "origin.git");
        const human = join(dir, "human");
        const agent = join(dir, "agent");
        const host = join(dir, "host");
        for (const home of ["human-home", "agent-home", "host-home"]) await mkdir(join(dir, home));
        const humanEnv = envFor(join(dir, "human-home"));
        // The agent has no identity at all: no ~/.config/agedrop/identity, no AGEDROP_IDENTITY.
        const agentEnv = envFor(join(dir, "agent-home"));
        await run("git", ["init", "-q", "--bare", "-b", "main", origin]);

        // The owner sets up the repository with their key and the host's public key.
        await run("git", ["clone", "-q", origin, human], { env: humanEnv });
        let result = await spawnCli(["init", "--owner", "owner"], { cwd: human, env: humanEnv });
        expect(result.code, result.stderr).toBe(0);
        result = await spawnCli(["keygen", "owner", "--kind", "owner"], {
          cwd: human,
          env: humanEnv,
        });
        expect(result.code, result.stderr).toBe(0);
        const hostKey = join(dir, "host.key");
        result = await spawnCli(["keygen", "host", "--out", hostKey], {
          cwd: human,
          env: humanEnv,
        });
        expect(result.code, result.stderr).toBe(0);
        await writeFile(join(human, "agedrop.toml"), CONFIG);
        await git(human, humanEnv, "add", "-A");
        await git(human, humanEnv, "commit", "-q", "-m", "set up agedrop");
        await git(human, humanEnv, "push", "-q", "origin", "HEAD:main");

        // The agent files requests from its own clone and pushes them.
        await run("git", ["clone", "-q", origin, agent], { env: agentEnv });
        const agentOutput: Result[] = [];
        const asAgent = async (argv: string[]): Promise<Result> => {
          const r = await spawnCli(argv, { cwd: agent, env: agentEnv });
          agentOutput.push(r);
          return r;
        };
        result = await asAgent([
          "request",
          "host/app",
          "API_TOKEN",
          "--reason",
          "Token for the deploy hook (plan #3)",
          "--by",
          "hq plan session #3",
        ]);
        expect(result.code, result.stderr).toBe(0);
        const tokenId = result.stdout.trim();
        expect(tokenId).toMatch(/^[a-z2-9]{8}$/);
        const requestText = await readFile(join(agent, "requests", `${tokenId}.toml`), "utf8");
        expect(requestText).toMatch(/^scope = "host\/app"\nname = "API_TOKEN"\n/);
        expect(requestText).toContain(`requested_by = "hq plan session #3"`);

        // Retrying does not file a duplicate.
        result = await asAgent(["request", "host/app", "API_TOKEN", "--reason", "again"]);
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toBe(`${tokenId}\n`);
        expect(result.stderr).toContain("already requested");

        result = await asAgent([
          "request",
          "host/app",
          "signing_key",
          "--reason",
          "Signs webhook payloads",
          "--generate",
          "printf 'generated-%s\\n' 42",
        ]);
        expect(result.code, result.stderr).toBe(0);
        const keyId = result.stdout.trim();
        await git(agent, agentEnv, "add", "-A");
        await git(agent, agentEnv, "commit", "-q", "-m", "request two secrets");
        await git(agent, agentEnv, "push", "-q", "origin", "HEAD:main");

        // The owner sees the requests and fulfils them.
        await git(human, humanEnv, "pull", "-q", "--ff-only", "origin", "main");
        result = await spawnCli(["requests"], { cwd: human, env: humanEnv });
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toMatch(
          new RegExp(
            `^${tokenId}\\s+host/app/API_TOKEN\\s+\\d{4}-\\d{2}-\\d{2}\\s+hq plan session #3\\s+Token for the deploy hook`,
            "m",
          ),
        );
        result = await spawnCli(["requests", "--json"], { cwd: human, env: humanEnv });
        const listed = JSON.parse(result.stdout) as { id: string; generate?: string }[];
        expect(listed.find((r) => r.id === keyId)?.generate).toBe("printf 'generated-%s\\n' 42");
        result = await spawnCli(["ls"], { cwd: human, env: humanEnv });
        expect(result.stdout).toContain(`${tokenId}  host/app/API_TOKEN`);

        // An unrelated staged change must stay out of the fulfil commit.
        await writeFile(join(human, "notes.txt"), "unrelated\n");
        await git(human, humanEnv, "add", "notes.txt");

        // Piped from a file, as `fulfil <id> < token-file`: the env-style value loses the newline.
        const value = "s3cret-from-the-owner";
        result = await spawnCli(["fulfil", tokenId], {
          cwd: human,
          env: humanEnv,
          stdin: `${value}\n`,
        });
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout + result.stderr).not.toContain(value);
        expect(result.stderr).toContain("Token for the deploy hook");
        expect(result.stderr).toContain("readable by:  host, owner");
        const files = await git(human, humanEnv, "show", "--name-status", "--format=%s", "HEAD");
        expect(files.trim().split("\n")).toEqual([
          `chore(secrets): fulfil host/app/API_TOKEN (request ${tokenId})`,
          "",
          "M\tagedrop.lock",
          `D\trequests/${tokenId}.toml`,
          "A\tsecrets/host/app/API_TOKEN.age",
        ]);
        expect(await git(human, humanEnv, "diff", "--cached", "--name-only")).toBe("notes.txt\n");
        await git(human, humanEnv, "reset", "-q", "notes.txt");
        await rm(join(human, "notes.txt"));

        // A failing generate command writes nothing.
        await writeFile(
          join(human, "requests", "broken.toml"),
          `scope = "host/app"\nname = "BROKEN"\nreason = "r"\nrequested_by = "a"\ncreated = "2026-11-14T00:00:00Z"\ngenerate = "echo oops >&2; exit 3"\n`,
        );
        result = await spawnCli(["fulfil", "broken", "--generate"], { cwd: human, env: humanEnv });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("oops");
        expect(result.stderr).toContain(
          "the generate command failed (exit 3); nothing was written",
        );
        await rm(join(human, "requests", "broken.toml"));

        // The generate hint runs only when asked to; its output is the value and is not printed.
        result = await spawnCli(["fulfil", keyId, "--generate"], { cwd: human, env: humanEnv });
        expect(result.code, result.stderr).toBe(0);
        expect(result.stderr).toContain("running: printf 'generated-%s\\n' 42");
        expect(result.stdout + result.stderr).not.toContain("generated-42");
        result = await spawnCli(["check"], { cwd: human, env: humanEnv });
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toBe("ok: 2 secrets in 1 scope, 2 recipients, 0 open requests\n");
        await git(human, humanEnv, "push", "-q", "origin", "HEAD:main");

        // The agent sees that the requests are closed, but cannot read the values.
        await git(agent, agentEnv, "pull", "-q", "--ff-only", "origin", "main");
        result = await asAgent(["requests"]);
        expect(result.code, result.stderr).toBe(0);
        expect(result.stderr).toBe("no open requests\n");
        result = await asAgent(["ls"]);
        expect(result.stdout).toMatch(/^host\/app\/API_TOKEN\s+ok\s/m);
        result = await asAgent(["pull", "host/app", "--env", "-"]);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("no identity");
        for (const output of agentOutput) {
          expect(output.stdout + output.stderr).not.toContain(value);
          expect(output.stdout + output.stderr).not.toContain("generated-42");
        }

        // The host pulls the values with its own identity.
        await run("git", ["clone", "-q", origin, host], { env: humanEnv });
        const hostEnv = envFor(join(dir, "host-home"), {
          AGEDROP_IDENTITY: await readFile(hostKey, "utf8"),
        });
        const out = join(dir, "out");
        result = await spawnCli(["pull", "host/app", "--to", out], { cwd: host, env: hostEnv });
        expect(result.code, result.stderr).toBe(0);
        expect(await readFile(join(out, "API_TOKEN"), "utf8")).toBe(value);
        // A file-style value keeps the exact bytes, trailing newline included.
        expect(await readFile(join(out, "signing_key"), "utf8")).toBe("generated-42\n");

        // And the stock age CLI reads what fulfil wrote.
        const decrypted = await run(
          "age",
          ["-d", "-i", hostKey, join(host, "secrets/host/app/API_TOKEN.age")],
          { env: hostEnv },
        );
        expect(decrypted.stdout).toBe(value);
      });
    },
  );

  it(
    "remove a recipient → rekey → the rotation list, and the removed key cannot decrypt",
    { timeout: 120_000 },
    async () => {
      await withTempDir(async (dir) => {
        const repo = join(dir, "repo");
        await mkdir(repo);
        await mkdir(join(dir, "home"));
        const env = envFor(join(dir, "home"));
        await run("git", ["init", "-q"], { cwd: repo, env });
        let result = await spawnCli(["init", "--owner", "owner"], { cwd: repo, env });
        expect(result.code, result.stderr).toBe(0);
        const keys = { owner: join(dir, "owner.key"), host: "", laptop: "" };
        for (const name of ["owner", "host", "laptop"] as const) {
          keys[name] = join(dir, `${name}.key`);
          result = await spawnCli(
            ["keygen", name, "--out", keys[name], "--kind", name === "owner" ? "owner" : "machine"],
            { cwd: repo, env },
          );
          expect(result.code, result.stderr).toBe(0);
        }
        const laptopRecipient = (await readFile(join(repo, "recipients", "laptop.pub"), "utf8"))
          .split("\n")
          .find((line) => line.startsWith("age1"));
        await writeFile(
          join(repo, "agedrop.toml"),
          `version = 0\n\n[recipients]\nowners = ["owner"]\nhosts = ["host", "laptop"]\n\n` +
            `[scopes."host/app"]\nrecipients = ["owners", "hosts"]\n\n[scopes.vault]\nrecipients = ["owners"]\n`,
        );
        for (const [scope, name, value] of [
          ["host/app", "API_TOKEN", "token-v1"],
          ["host/app", "tls.key", "key-v1"],
          ["vault", "BACKUP_PASSPHRASE", "passphrase-v1"],
        ] as const) {
          result = await spawnCli(["add", scope, name], { cwd: repo, env, stdin: value });
          expect(result.code, result.stderr).toBe(0);
        }
        await run("git", ["add", "-A"], { cwd: repo, env });
        await run("git", ["commit", "-q", "-m", "add secrets"], { cwd: repo, env });

        // Nothing is stale yet.
        result = await spawnCli(["rekey", "--identity", keys.owner], { cwd: repo, env });
        expect(result.code, result.stderr).toBe(0);
        expect(result.stderr).toBe("nothing to rekey: every secret is up to date\n");

        // The laptop is retired: out of the group, its public key deleted.
        await writeFile(
          join(repo, "agedrop.toml"),
          (await readFile(join(repo, "agedrop.toml"), "utf8")).replace(
            `hosts = ["host", "laptop"]`,
            `hosts = ["host"]`,
          ),
        );
        await rm(join(repo, "recipients", "laptop.pub"));
        result = await spawnCli(["ls"], { cwd: repo, env });
        expect(result.stdout).toMatch(/^host\/app\/API_TOKEN\s+stale/m);
        expect(result.stdout).toMatch(/^vault\/BACKUP_PASSPHRASE\s+ok/m);
        result = await spawnCli(["check"], { cwd: repo, env });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("secrets/host/app/API_TOKEN.age: stale");

        // rekey needs an owner identity: the host's key can read the secrets but is refused.
        result = await spawnCli(["rekey", "--identity", keys.host], { cwd: repo, env });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("rekey needs an owner identity");
        result = await spawnCli(["rekey"], { cwd: repo, env });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("no identity");

        result = await spawnCli(["rekey", "--identity", keys.owner], { cwd: repo, env });
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toBe(
          `rotate host/app/API_TOKEN: no longer for laptop (${laptopRecipient ?? ""})\n` +
            `rotate host/app/tls.key: no longer for laptop (${laptopRecipient ?? ""})\n`,
        );
        expect(result.stderr).toContain("rekeyed 2 secrets");
        expect(result.stderr).toContain("2 secrets to rotate");
        for (const v of ["token-v1", "key-v1", "passphrase-v1"]) {
          expect(result.stdout + result.stderr).not.toContain(v);
        }

        // The removed key cannot decrypt the new files; the host and the owner still can.
        const file = join(repo, "secrets/host/app/API_TOKEN.age");
        await expect(run("age", ["-d", "-i", keys.laptop, file], { env })).rejects.toThrow();
        result = await spawnCli(["pull", "host/app", "--env", "-", "--identity", keys.laptop], {
          cwd: repo,
          env,
        });
        expect(result.code).toBe(1);
        expect((await run("age", ["-d", "-i", keys.host, file], { env })).stdout).toBe("token-v1");
        expect((await run("age", ["-d", "-i", keys.owner, file], { env })).stdout).toBe("token-v1");

        // ...but history still can, which is why the values must be rotated.
        const old = await run("git", ["show", "HEAD:secrets/host/app/API_TOKEN.age"], {
          cwd: repo,
          env,
        });
        const oldFile = join(dir, "old.age");
        await writeFile(oldFile, old.stdout);
        expect((await run("age", ["-d", "-i", keys.laptop, oldFile], { env })).stdout).toBe(
          "token-v1",
        );

        // The repository is consistent again, and the lock no longer names the laptop.
        result = await spawnCli(["check"], { cwd: repo, env });
        expect(result.code, result.stderr).toBe(0);
        expect(await readFile(join(repo, "agedrop.lock"), "utf8")).not.toContain("laptop");
        result = await spawnCli(["rekey", "--identity", keys.owner], { cwd: repo, env });
        expect(result.stderr).toBe("nothing to rekey: every secret is up to date\n");
      });
    },
  );
});

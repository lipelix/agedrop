/** The web UI's GitHub client, snapshot and writes (SPEC.md § Web UI), against an in-memory GitHub. */
import { describe, expect, it } from "vitest";
import { encryptSecret, parseLock } from "../src/index.js";
import { GitHubClient, GitHubError } from "../web/src/github.js";
import { loadSnapshot } from "../web/src/snapshot.js";
import {
  commitWrite,
  generateValue,
  prepareWrite,
  valueProblem,
  WriteError,
} from "../web/src/write.js";
import { FAKE_TOKEN, type FakeGitHub } from "./fake-github.js";
import { ageDecrypt, throwawayKey } from "./helpers.js";
import { REPOSITORY, webFixture } from "./web-fixture.js";

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

function clientFor(github: FakeGitHub, token = FAKE_TOKEN): GitHubClient {
  return new GitHubClient(REPOSITORY, token, (input, init) => github.fetch(input, init));
}

/** Every byte the page sent, decoded where it was base64, to search for a plaintext value. */
function everythingSent(github: FakeGitHub): string {
  return github.requests
    .map((request) => {
      const decoded = [...request.body.matchAll(/"contents":"([^"]+)"/g)].map((match) =>
        Buffer.from(match[1] ?? "", "base64").toString("utf8"),
      );
      return [request.url, JSON.stringify(request.headers), request.body, ...decoded].join("\n");
    })
    .join("\n");
}

describe("web snapshot", () => {
  it("reads owner identity files and reports the ones that do not belong to an owner", async () => {
    const { github, ownerIdentity } = await webFixture();
    const wrapped = await encryptSecret(ownerIdentity, [(await throwawayKey()).recipient]);
    github.push("recipients/owner.identity.age", wrapped);
    github.push("recipients/mini.identity.age", wrapped);
    github.push("recipients/ghost.identity.age", "not age");
    const snapshot = await loadSnapshot(clientFor(github));
    expect([...snapshot.ownerIdentities.keys()]).toEqual(["owner"]);
    expect(snapshot.ownerIdentities.get("owner")).toBe(wrapped);
    expect(snapshot.problems).toEqual([
      "recipients/ghost.identity.age: not an ASCII-armored age file",
      "recipients/ghost.identity.age: no recipients/ghost.pub next to it",
      'recipients/mini.identity.age: recipients/mini.pub is of kind "machine", not "owner"',
    ]);
    expect(snapshot.secrets.every((secret) => secret.sha !== undefined)).toBe(true);
  });

  it("lists scopes, secrets with status and last change, and requests", async () => {
    const { github } = await webFixture();
    const snapshot = await loadSnapshot(clientFor(github));
    expect(snapshot.problems).toEqual([]);
    expect(snapshot.branch).toBe("main");
    expect(snapshot.head).toBe(github.head);
    expect(snapshot.scopes.map((scope) => [scope.scope, scope.resolved?.names])).toEqual([
      ["ci/deploy", ["owner"]],
      ["mini/hq", ["mini", "owner"]],
    ]);
    expect(
      snapshot.secrets.map((secret) => [secret.scope, secret.name, secret.status, secret.kind]),
    ).toEqual([
      ["ci/deploy", "NPM_TOKEN", "stale", "env"],
      ["mini/hq", "DATABASE_URL", "ok", "env"],
    ]);
    expect(snapshot.secrets[1]?.lastChange?.author).toBe("lipelix");
    expect(snapshot.requests.map((request) => request.id)).toEqual(["k7mq2xpa"]);
  });

  it("reports problems instead of throwing on a malformed repository", async () => {
    const { github } = await webFixture();
    github.push("agedrop.toml", 'version = 0\ntypo = 1\n[recipients]\nowners = ["owner"]\n');
    github.push("secrets/nowhere/X.age", "-----BEGIN AGE ENCRYPTED FILE-----\n");
    github.push("secrets/bad.age", "x");
    const snapshot = await loadSnapshot(clientFor(github));
    expect(snapshot.problems).toContain('agedrop.toml: unknown key "typo"');
    expect(snapshot.problems).toContain("secrets/bad.age: not secrets/<scope>/<NAME>.age");
    expect(snapshot.config).toBeUndefined();
    expect(snapshot.secrets.find((secret) => secret.scope === "nowhere")?.status).toBe(
      "unknown scope",
    );
    await expect(
      prepareWrite(snapshot, { scope: "mini/hq", name: "TOKEN", value: text("x") }),
    ).rejects.toThrow(WriteError);
  });

  it("explains a rejected token and a missing repository", async () => {
    const { github } = await webFixture();
    await expect(loadSnapshot(clientFor(github, "wrong"))).rejects.toThrow(/rejected the token/);
    const other = new GitHubClient("someone/other", FAKE_TOKEN, (input, init) =>
      github.fetch(input, init),
    );
    await expect(loadSnapshot(other)).rejects.toThrow(/not found, or the token has no access/);
  });
});

describe("web writes", () => {
  it("fulfils a request in one commit that age decrypts on the target host", async () => {
    const { github, miniIdentity, ownerIdentity } = await webFixture();
    const client = clientFor(github);
    const snapshot = await loadSnapshot(client);
    const value = "-----BEGIN EC PRIVATE KEY-----\nthrowaway\n-----END EC PRIVATE KEY-----\n";

    const result = await commitWrite(client, snapshot, {
      scope: "mini/hq",
      name: "VAPID_PRIVATE_KEY",
      value: text(value),
      requestId: "k7mq2xpa",
    });

    expect(result.message).toBe(
      "chore(secrets): fulfil mini/hq/VAPID_PRIVATE_KEY (request k7mq2xpa)",
    );
    const last = github.commits.at(-1);
    expect([...(last?.changed ?? [])].sort()).toEqual([
      "agedrop.lock",
      "requests/k7mq2xpa.toml",
      "secrets/mini/hq/VAPID_PRIVATE_KEY.age",
    ]);
    expect(github.files.has("requests/k7mq2xpa.toml")).toBe(false);
    const armored = github.files.get("secrets/mini/hq/VAPID_PRIVATE_KEY.age") ?? "";
    expect(armored).toMatch(/^-----BEGIN AGE ENCRYPTED FILE-----\n/);
    expect(await ageDecrypt(armored, miniIdentity)).toBe(value);
    expect(await ageDecrypt(armored, ownerIdentity)).toBe(value);

    const lock = parseLock(github.files.get("agedrop.lock") ?? "");
    expect(lock.secrets.get("mini/hq/VAPID_PRIVATE_KEY")).toBe(
      lock.secrets.get("mini/hq/DATABASE_URL"),
    );

    const after = await loadSnapshot(client);
    expect(after.requests).toEqual([]);
    expect(after.secrets.find((secret) => secret.name === "VAPID_PRIVATE_KEY")?.status).toBe("ok");
    expect(everythingSent(github)).not.toContain("throwaway\n-----END");
  });

  it("adds, replaces and re-encrypts a stale secret to the current recipients", async () => {
    const { github, ownerIdentity } = await webFixture();
    const client = clientFor(github);
    const added = await commitWrite(client, await loadSnapshot(client), {
      scope: "ci/deploy",
      name: "deploy_key",
      value: text("file\nbytes\n"),
    });
    expect(added.message).toBe("chore(secrets): add ci/deploy/deploy_key");
    const replaced = await commitWrite(client, await loadSnapshot(client), {
      scope: "ci/deploy",
      name: "NPM_TOKEN",
      value: text("npm_new_throwaway"),
    });
    expect(replaced.message).toBe("chore(secrets): replace ci/deploy/NPM_TOKEN");
    const snapshot = await loadSnapshot(client);
    expect(snapshot.secrets.every((secret) => secret.status === "ok")).toBe(true);
    expect(
      await ageDecrypt(github.files.get("secrets/ci/deploy/deploy_key.age") ?? "", ownerIdentity),
    ).toBe("file\nbytes\n");
    expect(everythingSent(github)).not.toContain("npm_new_throwaway");
  });

  it("retries once on a moved head, encrypting to the recipients it then finds", async () => {
    const { github } = await webFixture();
    const client = clientFor(github);
    const snapshot = await loadSnapshot(client);
    github.racePushes = 1;
    await commitWrite(client, snapshot, { scope: "mini/hq", name: "TOKEN", value: text("v1") });
    expect(github.commits.at(-1)?.message).toBe("chore(secrets): add mini/hq/TOKEN");
    expect(github.files.get("README.md")).toMatch(/pushed elsewhere/);

    const stale = await loadSnapshot(client);
    github.racePushes = 2;
    await expect(
      commitWrite(client, stale, { scope: "mini/hq", name: "TOKEN", value: text("v2") }),
    ).rejects.toSatisfy((error) => error instanceof GitHubError && error.stale);
  });

  it("refuses a request that is gone or does not match", async () => {
    const { github } = await webFixture();
    const client = clientFor(github);
    const snapshot = await loadSnapshot(client);
    github.push("requests/k7mq2xpa.toml", undefined);
    await expect(
      commitWrite(client, snapshot, {
        scope: "mini/hq",
        name: "VAPID_PRIVATE_KEY",
        value: text("x"),
        requestId: "k7mq2xpa",
      }),
    ).rejects.toThrow(/no longer open/);
    await expect(
      prepareWrite(snapshot, {
        scope: "ci/deploy",
        name: "VAPID_PRIVATE_KEY",
        value: text("x"),
        requestId: "k7mq2xpa",
      }),
    ).rejects.toThrow(/asks for mini\/hq\/VAPID_PRIVATE_KEY/);
    await expect(
      prepareWrite(snapshot, { scope: "nowhere", name: "X", value: text("x") }),
    ).rejects.toThrow(/not in agedrop.toml/);
  });
});

describe("web values", () => {
  it("checks values like the CLI", () => {
    expect(valueProblem("TOKEN", new Uint8Array())).toMatch(/empty/);
    expect(valueProblem("TOKEN", Uint8Array.of(0x61, 0))).toMatch(/NUL/);
    expect(valueProblem("TOKEN", Uint8Array.of(0xff))).toMatch(/UTF-8/);
    expect(valueProblem("tls.key", Uint8Array.of(0, 0xff))).toBeUndefined();
    expect(valueProblem("tls.key", new Uint8Array(1024 * 1024 + 1))).toMatch(/1 MiB/);
  });

  it("generates 32 random bytes as base64url", () => {
    const a = generateValue();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateValue()).not.toBe(a);
  });
});

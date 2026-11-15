import { createECDH, createPublicKey, randomBytes, verify } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import * as ece from "http_ece";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { webhookSignature } from "../src/cli/notify.js";
import {
  encryptPushPayload,
  parseSubscriptions,
  parseVapidKey,
  vapidAuthorization,
} from "../src/cli/webpush.js";
import { GITHUB_WORKFLOW_PATH } from "../src/cli/workflow.js";
import { envFor, makeRepo, runCli } from "./cli-helpers.js";
import { run, withTempDir } from "./helpers.js";

/** A browser's side of a push subscription: its ECDH key and auth secret. */
function browserSubscription(endpoint = "https://push.example.invalid/send/abc123") {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    ecdh,
    auth,
    subscription: {
      endpoint,
      keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") },
    },
  };
}

function vapidKeyPair() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    privateKey: ecdh.getPrivateKey().toString("base64url"),
    publicKey: ecdh.getPublicKey().toString("base64url"),
  };
}

/** Checks a VAPID `Authorization` header and returns the JWT's claims. */
function checkVapid(header: string, publicKey: string): Record<string, unknown> {
  const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(\S+)$/.exec(header);
  if (match === null) throw new Error(`not a VAPID header: ${header}`);
  const [, head = "", claims = "", signature = "", k = ""] = match;
  expect(k).toBe(publicKey);
  const pub = Buffer.from(k, "base64url");
  const key = createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: pub.subarray(1, 33).toString("base64url"),
      y: pub.subarray(33).toString("base64url"),
    },
    format: "jwk",
  });
  const valid = verify(
    "sha256",
    Buffer.from(`${head}.${claims}`),
    { key, dsaEncoding: "ieee-p1363" },
    Buffer.from(signature, "base64url"),
  );
  expect(valid).toBe(true);
  expect(JSON.parse(Buffer.from(head, "base64url").toString())).toEqual({
    typ: "JWT",
    alg: "ES256",
  });
  return JSON.parse(Buffer.from(claims, "base64url").toString()) as Record<string, unknown>;
}

describe("Web Push", () => {
  it("encrypts so that http_ece (the web-push library's decryptor) reads it back", () => {
    const browser = browserSubscription();
    const message = Buffer.from(JSON.stringify({ hello: "push", ü: "ñ" }));
    const body = Buffer.from(encryptPushPayload(message, browser.subscription));
    expect(body.readUInt32BE(16)).toBe(4096);
    expect(body[20]).toBe(65);
    const plain = ece.decrypt(body, {
      version: "aes128gcm",
      privateKey: browser.ecdh,
      authSecret: browser.auth,
    });
    expect(plain.equals(message)).toBe(true);
    // Fresh salt and sender key every time.
    expect(Buffer.from(encryptPushPayload(message, browser.subscription)).equals(body)).toBe(false);
  });

  it("refuses a message larger than one record", () => {
    const { subscription } = browserSubscription();
    expect(() => encryptPushPayload(new Uint8Array(4080), subscription)).toThrow(
      /more than a push/,
    );
  });

  it("signs a VAPID JWT for the endpoint's origin", () => {
    const pair = vapidKeyPair();
    const vapid = parseVapidKey(pair.privateKey);
    expect(vapid.publicKey).toBe(pair.publicKey);
    const now = Date.UTC(2026, 10, 14, 12);
    const claims = checkVapid(
      vapidAuthorization(
        "https://web.push.apple.com/abc/def?x=1",
        "mailto:ops@example.invalid",
        vapid,
        now,
      ),
      pair.publicKey,
    );
    expect(claims).toEqual({
      aud: "https://web.push.apple.com",
      exp: now / 1000 + 12 * 3600,
      sub: "mailto:ops@example.invalid",
    });
  });

  it("validates subscriptions and keys", () => {
    const { subscription } = browserSubscription();
    expect(parseSubscriptions(JSON.stringify(subscription))).toEqual([subscription]);
    expect(parseSubscriptions(JSON.stringify([subscription, subscription]))).toHaveLength(2);
    expect(() => parseSubscriptions("{")).toThrow("not valid JSON");
    expect(() => parseSubscriptions("[]")).toThrow("no subscription");
    expect(() =>
      parseSubscriptions(JSON.stringify({ ...subscription, endpoint: "http://x" })),
    ).toThrow("https");
    const badKey = { ...subscription, keys: { ...subscription.keys, p256dh: "AAAA" } };
    expect(() => parseSubscriptions(JSON.stringify(badKey))).toThrow("p256dh");
    const offCurve = Buffer.alloc(65, 7);
    offCurve[0] = 4;
    const offCurveKey = {
      ...subscription,
      keys: { ...subscription.keys, p256dh: offCurve.toString("base64url") },
    };
    expect(() => parseSubscriptions(JSON.stringify(offCurveKey))).toThrow("p256dh");
    const badAuth = { ...subscription, keys: { ...subscription.keys, auth: "AAAA" } };
    expect(() => parseSubscriptions(JSON.stringify([subscription, badAuth]))).toThrow(
      "subscription 2",
    );
    expect(() => parseVapidKey("short")).toThrow("32-byte");
  });
});

interface Received {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

describe("agedrop notify", () => {
  let server: Server;
  let base: string;
  const received: Received[] = [];
  let status = 200;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      req.on("end", () => {
        received.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
        res.writeHead(status).end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });
  afterAll(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  );
  afterEach(() => {
    received.length = 0;
    status = 200;
    vi.restoreAllMocks();
  });

  /** A repository with two open requests: one new secret and one rotation. */
  async function repoWithRequests(dir: string): Promise<{ fresh: string; rotation: string }> {
    await makeRepo(dir);
    const add = await runCli(["add", "host/app", "DB_URL"], {
      cwd: dir,
      home: dir,
      stdin: "s3cr3t-value",
    });
    expect(add.code, add.stderr).toBe(0);
    const file = async (name: string, reason: string, extra: string[] = []) => {
      const result = await runCli(
        ["request", "host/app", name, "--reason", reason, "--by", "agent #7", ...extra],
        { cwd: dir, home: dir },
      );
      expect(result.code, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    const fresh = await file("API_KEY", "for the deploy", ["--generate", "openssl rand -hex 32"]);
    const rotation = await file("DB_URL", "the old one leaked");
    return { fresh, rotation };
  }

  it("prints the notifications with --dry-run, with no value and no generate hint", async () => {
    await withTempDir(async (dir) => {
      const { fresh, rotation } = await repoWithRequests(dir);
      const result = await runCli(["notify", "--dry-run", "--github", "me/secrets"], {
        cwd: dir,
        home: dir,
      });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).not.toContain("s3cr3t");
      expect(result.stdout).not.toContain("openssl");
      const lines = result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const byId = new Map(lines.map((n) => [(n.request as { id: string }).id, n]));
      expect(byId.get(fresh)).toEqual({
        type: "agedrop.request",
        repository: "me/secrets",
        request: {
          id: fresh,
          scope: "host/app",
          name: "API_KEY",
          reason: "for the deploy",
          requested_by: "agent #7",
          created: expect.stringMatching(/Z$/) as unknown,
        },
        rotation: false,
        url: `https://app.agedrop.dev/#/requests/${fresh}?repo=me%2Fsecrets`,
        title: "Secret requested: host/app/API_KEY",
        message: "for the deploy\nby agent #7",
      });
      expect(byId.get(rotation)).toMatchObject({
        rotation: true,
        title: "New value requested: host/app/DB_URL",
      });
    });
  });

  it("posts to ntfy and a signed webhook", async () => {
    await withTempDir(async (dir) => {
      const { fresh } = await repoWithRequests(dir);
      const env = {
        GITHUB_REPOSITORY: "me/secrets",
        AGEDROP_NTFY_URL: `${base}/agedrop-topic`,
        AGEDROP_NTFY_TOKEN: "tk_throwaway",
        AGEDROP_WEBHOOK_URL: `${base}/hooks/agedrop?key=1`,
        AGEDROP_WEBHOOK_SECRET: "throwaway-hmac-key",
      };
      const result = await runCli(["notify", fresh, "--app-url", "https://ui.example.invalid/"], {
        cwd: dir,
        home: dir,
        env,
      });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toContain("notified 1 of 1 request (ntfy, webhook)");
      expect(received).toHaveLength(2);
      const url = `https://ui.example.invalid/#/requests/${fresh}?repo=me%2Fsecrets`;

      const ntfy = received.find((r) => r.url === "/");
      expect(ntfy?.method).toBe("POST");
      expect(ntfy?.headers.authorization).toBe("Bearer tk_throwaway");
      expect(JSON.parse(ntfy?.body ?? "")).toEqual({
        topic: "agedrop-topic",
        title: "Secret requested: host/app/API_KEY",
        message: "for the deploy\nby agent #7",
        tags: ["key"],
        click: url,
      });

      const hook = received.find((r) => r.url === "/hooks/agedrop?key=1");
      expect(hook?.headers["content-type"]).toBe("application/json");
      expect(hook?.headers["x-agedrop-signature"]).toBe(
        webhookSignature("throwaway-hmac-key", hook?.body ?? ""),
      );
      expect(JSON.parse(hook?.body ?? "")).toMatchObject({
        type: "agedrop.request",
        url,
        rotation: false,
      });
    });
  });

  it("sends an encrypted, VAPID-signed Web Push to each subscription", async () => {
    await withTempDir(async (dir) => {
      const { fresh } = await repoWithRequests(dir);
      const one = browserSubscription("https://push.example.invalid/one");
      const two = browserSubscription("https://push.example.invalid/two");
      const pair = vapidKeyPair();
      const calls: { url: string; init: RequestInit }[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
        calls.push({ url: url as string, init: init ?? {} });
        return Promise.resolve(
          new Response(null, { status: url === two.subscription.endpoint ? 410 : 201 }),
        );
      });
      const result = await runCli(["notify", fresh], {
        cwd: dir,
        home: dir,
        env: {
          AGEDROP_WEBPUSH_SUBSCRIPTIONS: JSON.stringify([one.subscription, two.subscription]),
          AGEDROP_VAPID_PRIVATE_KEY: pair.privateKey,
          AGEDROP_VAPID_SUBJECT: "mailto:ops@example.invalid",
        },
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        `agedrop: web push 2 (push.example.invalid): request ${fresh}: HTTP 410: the push service dropped the subscription`,
      );
      expect(result.stderr).not.toContain("/two");
      expect(result.stderr).toContain("notified 1 of 1 request");
      expect(calls.map((c) => c.url)).toEqual([
        one.subscription.endpoint,
        two.subscription.endpoint,
      ]);

      const call = calls[0];
      const headers = call?.init.headers as Record<string, string>;
      expect(headers["Content-Encoding"]).toBe("aes128gcm");
      expect(headers.TTL).toBe("86400");
      expect(headers.Urgency).toBe("high");
      const claims = checkVapid(headers.Authorization ?? "", pair.publicKey);
      expect(claims).toMatchObject({
        aud: "https://push.example.invalid",
        sub: "mailto:ops@example.invalid",
      });
      const plain = ece.decrypt(Buffer.from(call?.init.body as Uint8Array), {
        version: "aes128gcm",
        privateKey: one.ecdh,
        authSecret: one.auth,
      });
      expect(JSON.parse(plain.toString("utf8"))).toMatchObject({
        type: "agedrop.request",
        request: { id: fresh, name: "API_KEY" },
      });
    });
  });

  it("reports a failed delivery without its URL and keeps going", async () => {
    await withTempDir(async (dir) => {
      const { fresh, rotation } = await repoWithRequests(dir);
      status = 500;
      const result = await runCli(["notify"], {
        cwd: dir,
        home: dir,
        env: { AGEDROP_WEBHOOK_URL: `${base}/hook-with-token-xyz` },
      });
      expect(result.code).toBe(1);
      expect(received).toHaveLength(2);
      expect(result.stderr).toContain(`agedrop: webhook: request ${fresh}: HTTP 500`);
      expect(result.stderr).toContain(`agedrop: webhook: request ${rotation}: HTTP 500`);
      expect(result.stderr).not.toContain("token-xyz");
      expect(result.stderr).toContain("notified 0 of 2 requests");
      // No link without a GitHub repository.
      expect(JSON.parse(received[0]?.body ?? "")).not.toHaveProperty("url");
    });
  });

  it("notifies only the requests added since a revision", async () => {
    await withTempDir(async (dir) => {
      const env = envFor(dir);
      await run("git", ["init", "-q", "-b", "main"], { cwd: dir, env });
      await makeRepo(dir);
      const request = async (name: string) => {
        const result = await runCli(["request", "other", name, "--reason", "r", "--by", "a"], {
          cwd: dir,
          home: dir,
        });
        await run("git", ["add", "-A"], { cwd: dir, env });
        await run("git", ["commit", "-q", "-m", `request ${name}`], { cwd: dir, env });
        return result.stdout.trim();
      };
      const first = await request("FIRST");
      const before = (await run("git", ["rev-parse", "HEAD"], { cwd: dir, env })).stdout.trim();
      const second = await request("SECOND");
      const ids = async (since: string) => {
        const result = await runCli(["notify", "--dry-run", "--since", since], {
          cwd: dir,
          home: dir,
          env,
        });
        expect(result.code, result.stderr).toBe(0);
        return result.stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => (JSON.parse(line) as { request: { id: string } }).request.id)
          .sort();
      };
      expect(await ids(before)).toEqual([second]);
      expect(await ids("HEAD")).toEqual([]);
      expect(await ids("0".repeat(40))).toEqual([first, second].sort());

      const empty = await runCli(["notify", "--since", "HEAD"], {
        cwd: dir,
        home: dir,
        env: { AGEDROP_NTFY_URL: `${base}/t` },
      });
      expect(empty.code).toBe(0);
      expect(empty.stderr).toContain("no requests added since HEAD");
      expect(received).toHaveLength(0);

      const unknown = await runCli(["notify", "--dry-run", "--since", "deadbeef"], {
        cwd: dir,
        home: dir,
      });
      expect(unknown.code).toBe(1);
      expect(unknown.stderr).toContain("cannot list the requests added since deadbeef");
    });
  });

  it("fails fast on missing or partial targets and bad arguments", async () => {
    await withTempDir(async (dir) => {
      await repoWithRequests(dir);
      const pair = vapidKeyPair();
      for (const [argv, env, code, message] of [
        [[], {}, 1, "no notification target"],
        [[], { AGEDROP_NTFY_URL: "" }, 1, "no notification target"],
        [
          [],
          { AGEDROP_NTFY_TOKEN: "t" },
          1,
          "AGEDROP_NTFY_TOKEN is set but AGEDROP_NTFY_URL is not",
        ],
        [[], { AGEDROP_NTFY_URL: "https://ntfy.sh/" }, 1, "must end with a topic"],
        [[], { AGEDROP_WEBHOOK_URL: "ftp://x/y" }, 1, "must be an https or http URL"],
        [
          [],
          { AGEDROP_VAPID_PRIVATE_KEY: pair.privateKey },
          1,
          "missing: AGEDROP_WEBPUSH_SUBSCRIPTIONS, AGEDROP_VAPID_SUBJECT",
        ],
        [
          [],
          {
            AGEDROP_WEBPUSH_SUBSCRIPTIONS: JSON.stringify(browserSubscription().subscription),
            AGEDROP_VAPID_PRIVATE_KEY: pair.privateKey,
            AGEDROP_VAPID_SUBJECT: "ops@example.invalid",
          },
          1,
          "AGEDROP_VAPID_SUBJECT must be a mailto: or https: URL",
        ],
        [["abc", "--since", "HEAD"], {}, 2, "not both"],
        [["--since=-p"], {}, 2, "invalid --since"],
        [["Bad!"], {}, 2, 'invalid request id "Bad!"'],
        [["--dry-run", "--github", "nope"], {}, 2, "invalid GitHub repository"],
        [["--dry-run", "missing1"], {}, 1, 'no open request "missing1"'],
      ] as const) {
        const result = await runCli(["notify", ...argv], { cwd: dir, home: dir, env });
        expect(result.code, `${argv.join(" ")} ${JSON.stringify(env)}: ${result.stderr}`).toBe(
          code,
        );
        expect(result.stderr).toContain(message);
      }
      expect(received).toHaveLength(0);
    });
  });

  it("skips a request file that does not validate", async () => {
    await withTempDir(async (dir) => {
      const { fresh } = await repoWithRequests(dir);
      await writeFile(join(dir, "requests", "broken.toml"), 'scope = "host/app"\n');
      const result = await runCli(["notify", "--dry-run"], { cwd: dir, home: dir });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('agedrop: requests/broken.toml: missing "name"');
      expect(result.stdout).toContain(fresh);
    });
  });

  it("cuts a long reason to 500 characters", async () => {
    await withTempDir(async (dir) => {
      await makeRepo(dir);
      await mkdir(join(dir, "requests"));
      const reason = "🔑".repeat(600);
      await writeFile(
        join(dir, "requests", "long.toml"),
        `scope = "other"\nname = "LONG"\nreason = "${reason}"\nrequested_by = "a"\ncreated = 2026-11-14T10:00:00Z\n`,
      );
      const result = await runCli(["notify", "--dry-run", "long"], { cwd: dir, home: dir });
      const n = JSON.parse(result.stdout) as { request: { reason: string } };
      expect(Array.from(n.request.reason)).toHaveLength(500);
      expect(n.request.reason.endsWith("🔑…")).toBe(true);
    });
  });
});

describe("agedrop init --ci github", () => {
  it("writes the workflow with a new repository, or alone in an existing one", async () => {
    await withTempDir(async (dir) => {
      const result = await runCli(["init", "--owner", "me", "--ci", "github"], {
        cwd: dir,
        home: dir,
      });
      expect(result.code, result.stderr).toBe(0);
      const workflow = await readFile(join(dir, GITHUB_WORKFLOW_PATH), "utf8");
      const pkg = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
      expect(workflow).toContain(`npx --yes agedrop@${pkg.version} notify --since "$BEFORE"`);
      expect(workflow).toContain('paths: ["requests/**"]');
      expect(workflow).toContain("AGEDROP_NTFY_URL: ${{ secrets.AGEDROP_NTFY_URL }}");
      expect(workflow).toContain("BEFORE: ${{ github.event.before }}");
      await readFile(join(dir, "agedrop.toml"), "utf8");

      const again = await runCli(["init", "--ci", "github"], { cwd: dir, home: dir });
      expect(again.code).toBe(1);
      expect(again.stderr).toContain(`${GITHUB_WORKFLOW_PATH} already exists`);
    });
    await withTempDir(async (dir) => {
      await makeRepo(dir);
      const config = await readFile(join(dir, "agedrop.toml"), "utf8");
      const result = await runCli(["init", "--ci", "github"], { cwd: dir, home: dir });
      expect(result.code, result.stderr).toBe(0);
      expect(await readFile(join(dir, "agedrop.toml"), "utf8")).toBe(config);
      await readFile(join(dir, GITHUB_WORKFLOW_PATH), "utf8");

      for (const [argv, code, message] of [
        [["init", "--owner", "me", "--ci", "github"], 1, "agedrop.toml already exists"],
        [["init"], 1, "agedrop.toml already exists"],
        [["init", "--ci", "gitlab"], 2, 'unknown --ci "gitlab"'],
      ] as const) {
        const bad = await runCli([...argv], { cwd: dir, home: dir });
        expect(bad.code).toBe(code);
        expect(bad.stderr).toContain(message);
      }
    });
  });
});

/**
 * An in-memory stand-in for the parts of the GitHub API the web UI calls. It keeps one branch as a
 * map of path → contents and records every request, so tests can check what left the page.
 */
import { createHash, randomBytes } from "node:crypto";

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface FakeCommit {
  readonly oid: string;
  readonly message: string;
  readonly author: string;
  readonly date: string;
  readonly changed: readonly string[];
}

export interface FakeResponse {
  readonly status: number;
  readonly body: unknown;
}

export const FAKE_TOKEN = "github_pat_throwaway_test_token";

export class FakeGitHub {
  readonly requests: RecordedRequest[] = [];
  readonly commits: FakeCommit[] = [];
  files: Map<string, string>;
  head: string;
  /** Commit attempts that find a push made elsewhere first, to test the stale-head retry. */
  racePushes = 0;

  constructor(
    readonly repository: string,
    files: Record<string, string>,
    readonly branch = "main",
  ) {
    this.files = new Map(Object.entries(files));
    this.head = this.recordCommit("chore: initial", "lipelix", [...this.files.keys()]);
  }

  /** Writes a file as another pusher would, moving the head. */
  push(path: string, contents: string | undefined, message = "chore: elsewhere"): void {
    if (contents === undefined) this.files.delete(path);
    else this.files.set(path, contents);
    this.head = this.recordCommit(message, "someone-else", [path]);
  }

  async fetch(input: string, init: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => (headers[key] = value));
    const body = typeof init.body === "string" ? init.body : "";
    const method = init.method ?? "GET";
    const result = this.handle(method, input, headers, body);
    return Promise.resolve(
      new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }

  handle(
    method: string,
    url: string,
    headers: Readonly<Record<string, string>>,
    body: string,
  ): FakeResponse {
    this.requests.push({ method, url, headers, body });
    if (headers.authorization !== `Bearer ${FAKE_TOKEN}`) {
      return { status: 401, body: { message: "Bad credentials" } };
    }
    const parsed = new URL(url);
    if (parsed.origin !== "https://api.github.com") return { status: 404, body: {} };
    const path = decodeURIComponent(parsed.pathname);
    const prefix = `/repos/${this.repository}`;

    if (method === "POST" && path === "/graphql") return this.graphql(body);
    if (method !== "GET" || !path.startsWith(prefix)) {
      return { status: 404, body: { message: "Not Found" } };
    }
    const rest = path.slice(prefix.length);
    if (rest === "") {
      return { status: 200, body: { default_branch: this.branch, permissions: { push: true } } };
    }
    if (rest === `/git/ref/heads/${this.branch}`) {
      return { status: 200, body: { object: { sha: this.head } } };
    }
    if (rest.startsWith("/git/trees/")) {
      return { status: 200, body: { truncated: false, tree: this.tree() } };
    }
    if (rest.startsWith("/git/blobs/")) {
      const sha = rest.slice("/git/blobs/".length);
      for (const contents of this.files.values()) {
        if (blobSha(contents) === sha) {
          const base64 = Buffer.from(contents).toString("base64");
          // GitHub wraps base64 at 60 characters.
          return {
            status: 200,
            body: { encoding: "base64", content: base64.replace(/(.{60})/g, "$1\n") },
          };
        }
      }
      return { status: 404, body: { message: "Not Found" } };
    }
    if (rest === "/commits") {
      const file = parsed.searchParams.get("path") ?? "";
      const last = [...this.commits].reverse().find((commit) => commit.changed.includes(file));
      return {
        status: 200,
        body:
          last === undefined
            ? []
            : [
                {
                  sha: last.oid,
                  commit: { author: { name: last.author, date: last.date } },
                  author: { login: last.author },
                },
              ],
      };
    }
    return { status: 404, body: { message: "Not Found" } };
  }

  private graphql(body: string): FakeResponse {
    const request = JSON.parse(body) as {
      query: string;
      variables: {
        input: {
          branch: { repositoryNameWithOwner: string; branchName: string };
          expectedHeadOid: string;
          message: { headline: string };
          fileChanges: {
            additions?: { path: string; contents: string }[];
            deletions?: { path: string }[];
          };
        };
      };
    };
    if (!request.query.includes("createCommitOnBranch")) {
      return { status: 200, body: { errors: [{ message: "unsupported query" }] } };
    }
    const input = request.variables.input;
    if (
      input.branch.repositoryNameWithOwner !== this.repository ||
      input.branch.branchName !== this.branch
    ) {
      return { status: 200, body: { errors: [{ type: "NOT_FOUND", message: "no such branch" }] } };
    }
    // One push from elsewhere per commit attempt.
    if (this.racePushes > 0) {
      this.racePushes--;
      this.push("README.md", `pushed elsewhere ${String(this.commits.length)}\n`);
    }
    if (input.expectedHeadOid !== this.head) {
      return {
        status: 200,
        body: {
          data: { createCommitOnBranch: null },
          errors: [
            {
              type: "STALE_DATA",
              message: `Expected branch to point to "${input.expectedHeadOid}" but it did not. Pull and try again.`,
            },
          ],
        },
      };
    }
    const changed: string[] = [];
    for (const deletion of input.fileChanges.deletions ?? []) {
      if (!this.files.has(deletion.path)) {
        return { status: 200, body: { errors: [{ message: `no file ${deletion.path}` }] } };
      }
      this.files.delete(deletion.path);
      changed.push(deletion.path);
    }
    for (const addition of input.fileChanges.additions ?? []) {
      this.files.set(addition.path, Buffer.from(addition.contents, "base64").toString("utf8"));
      changed.push(addition.path);
    }
    this.head = this.recordCommit(input.message.headline, "lipelix", changed);
    return {
      status: 200,
      body: {
        data: {
          createCommitOnBranch: {
            commit: {
              oid: this.head,
              url: `https://github.com/${this.repository}/commit/${this.head}`,
            },
          },
        },
      },
    };
  }

  private tree(): { path: string; type: string; sha: string }[] {
    const entries = new Map<string, { path: string; type: string; sha: string }>();
    for (const [path, contents] of this.files) {
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join("/");
        entries.set(dir, { path: dir, type: "tree", sha: blobSha(dir) });
      }
      entries.set(path, { path, type: "blob", sha: blobSha(contents) });
    }
    return [...entries.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  private recordCommit(message: string, author: string, changed: string[]): string {
    const oid = randomBytes(20).toString("hex");
    const date = new Date(Date.UTC(2026, 10, 1) + this.commits.length * 86_400_000).toISOString();
    this.commits.push({ oid, message, author, date, changed });
    return oid;
  }
}

/** Git's blob id: SHA-1 of `blob <length>\0<contents>`. */
export function blobSha(contents: string): string {
  const bytes = Buffer.from(contents);
  return createHash("sha1")
    .update(`blob ${String(bytes.length)}\0`)
    .update(bytes)
    .digest("hex");
}

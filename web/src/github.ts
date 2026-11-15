/**
 * The small part of the GitHub API the web UI uses (SPEC.md § Web UI): REST for reads, and the GraphQL
 * `createCommitOnBranch` mutation for one atomic commit per action. Only ciphertext and public files
 * are ever sent.
 */

export const GITHUB_API = "https://api.github.com";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** A failed GitHub call, with a message fit to show. */
export class GitHubError extends Error {
  override readonly name = "GitHubError";
  constructor(
    message: string,
    readonly status: number,
    /** The head moved since the page loaded (`expectedHeadOid` did not match). */
    readonly stale = false,
  ) {
    super(message);
  }
}

export interface TreeEntry {
  readonly path: string;
  readonly type: "blob" | "tree" | "commit";
  readonly sha: string;
}

export interface LastChange {
  readonly date: string;
  readonly author: string;
}

export interface FileAddition {
  readonly path: string;
  readonly contents: string;
}

export interface CommitInput {
  readonly branch: string;
  readonly expectedHeadOid: string;
  readonly message: string;
  readonly additions: readonly FileAddition[];
  readonly deletions: readonly string[];
}

const CREATE_COMMIT = `mutation ($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) { commit { oid url } }
}`;

export class GitHubClient {
  readonly owner: string;
  readonly name: string;

  constructor(
    /** `owner/name`. */
    readonly repository: string,
    private readonly token: string,
    private readonly fetchImpl: Fetch = (input, init) => fetch(input, init),
  ) {
    const [owner, name, ...rest] = repository.split("/");
    if (owner === undefined || name === undefined || rest.length > 0 || !owner || !name) {
      throw new Error(`repository must look like owner/name, got "${repository}"`);
    }
    this.owner = owner;
    this.name = name;
  }

  async repo(): Promise<{ defaultBranch: string; canPush: boolean }> {
    const body = await this.get<{ default_branch: string; permissions?: { push?: boolean } }>(
      this.repoPath(""),
    );
    return { defaultBranch: body.default_branch, canPush: body.permissions?.push === true };
  }

  /** The commit a branch points to. */
  async head(branch: string): Promise<string> {
    const body = await this.get<{ object: { sha: string } }>(
      this.repoPath(`/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`),
    );
    return body.object.sha;
  }

  async tree(commit: string): Promise<TreeEntry[]> {
    const body = await this.get<{ tree: TreeEntry[]; truncated: boolean }>(
      this.repoPath(`/git/trees/${commit}?recursive=1`),
    );
    if (body.truncated) {
      throw new GitHubError("the repository tree is too large for the GitHub API to list", 0);
    }
    return body.tree;
  }

  async blobText(sha: string): Promise<string> {
    const body = await this.get<{ content: string; encoding: string }>(
      this.repoPath(`/git/blobs/${sha}`),
    );
    if (body.encoding !== "base64") throw new GitHubError(`unexpected blob encoding`, 0);
    return new TextDecoder().decode(fromBase64(body.content));
  }

  /** The last commit reachable from `commit` that touched `path`. */
  async lastChange(path: string, commit: string): Promise<LastChange | undefined> {
    const query = new URLSearchParams({ sha: commit, path, per_page: "1" });
    const body = await this.get<
      { commit: { author: { name: string; date: string } }; author: { login: string } | null }[]
    >(this.repoPath(`/commits?${query.toString()}`));
    const last = body[0];
    if (last === undefined) return undefined;
    return { date: last.commit.author.date, author: last.author?.login ?? last.commit.author.name };
  }

  /** One commit on top of `expectedHeadOid`; fails with `stale` when the branch moved. */
  async commit(input: CommitInput): Promise<{ oid: string; url: string }> {
    const variables = {
      input: {
        branch: { repositoryNameWithOwner: this.repository, branchName: input.branch },
        expectedHeadOid: input.expectedHeadOid,
        message: { headline: input.message },
        fileChanges: {
          additions: input.additions.map((file) => ({
            path: file.path,
            contents: toBase64(new TextEncoder().encode(file.contents)),
          })),
          deletions: input.deletions.map((path) => ({ path })),
        },
      },
    };
    const response = await this.request(`${GITHUB_API}/graphql`, {
      method: "POST",
      body: JSON.stringify({ query: CREATE_COMMIT, variables }),
    });
    const body = (await response.json()) as {
      data?: { createCommitOnBranch?: { commit: { oid: string; url: string } } | null };
      errors?: { type?: string; message: string }[];
    };
    const errors = body.errors ?? [];
    if (errors.length > 0) {
      const stale = errors.some(
        (error) =>
          error.type === "STALE_DATA" || /expected branch to point to/i.test(error.message),
      );
      throw new GitHubError(
        stale
          ? "the branch changed since the page loaded"
          : `GitHub refused the commit: ${errors.map((error) => error.message).join("; ")}`,
        response.status,
        stale,
      );
    }
    const commit = body.data?.createCommitOnBranch?.commit;
    if (commit === undefined) throw new GitHubError("GitHub returned no commit", response.status);
    return commit;
  }

  private repoPath(suffix: string): string {
    return `${GITHUB_API}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.name)}${suffix}`;
  }

  private async get<T>(url: string): Promise<T> {
    return (await (await this.request(url, { method: "GET" })).json()) as T;
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
    } catch {
      throw new GitHubError("cannot reach api.github.com: check the connection", 0);
    }
    if (response.ok) return response;
    throw new GitHubError(describeFailure(response.status, this.repository), response.status);
  }
}

function describeFailure(status: number, repository: string): string {
  switch (status) {
    case 401:
      return "GitHub rejected the token: it is wrong, expired or revoked";
    case 403:
      return `the token may not do this in ${repository}: it needs Contents read and write (or the rate limit is used up)`;
    case 404:
      return `${repository} was not found, or the token has no access to it`;
    case 409:
      return `${repository} is empty: it has no commits yet`;
    default:
      return `GitHub answered ${String(status)}`;
  }
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text.replace(/\s+/g, ""));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

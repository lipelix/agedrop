/**
 * Everything the web UI shows, read from one commit of the repository: the same checks and statuses as
 * `agedrop check` and `agedrop ls`, without decrypting anything.
 */
import {
  compareBytes,
  CONFIG_FILE,
  type Config,
  FormatError,
  LOCK_FILE,
  type Lock,
  lockIssues,
  missingRecipients,
  OWNER_IDENTITY_EXTENSION,
  ownerIdentityIssues,
  parseConfig,
  parseLock,
  parseRecipientFile,
  parseRequest,
  parseSecretPath,
  type RecipientInfo,
  RECIPIENT_EXTENSION,
  RECIPIENTS_DIR,
  recipientSetFingerprint,
  REQUESTS_DIR,
  resolveScope,
  type ResolvedScope,
  SECRETS_DIR,
  secretKind,
  type SecretKind,
  type SecretRequest,
} from "../../src/index.js";
import type { GitHubClient, LastChange } from "./github.js";

export type SecretStatus = "ok" | "stale" | "unknown scope";

export interface ScopeView {
  readonly scope: string;
  readonly groups: readonly string[];
  /** Undefined when the scope's recipients cannot be resolved (see `problems`). */
  readonly resolved?: ResolvedScope;
}

export interface SecretView {
  readonly path: string;
  readonly scope: string;
  readonly name: string;
  readonly kind: SecretKind;
  readonly status: SecretStatus;
  /** The file's blob, to read its ciphertext when an owner shows the value. */
  readonly sha?: string;
  readonly lastChange?: LastChange;
}

export interface Snapshot {
  readonly repository: string;
  readonly branch: string;
  /** The commit everything here was read from; writes name it as `expectedHeadOid`. */
  readonly head: string;
  readonly canPush: boolean;
  readonly config?: Config;
  readonly lock?: Lock;
  readonly scopes: readonly ScopeView[];
  readonly secrets: readonly SecretView[];
  readonly requests: readonly SecretRequest[];
  /** Every valid `recipients/*.pub`, by name. */
  readonly recipients: ReadonlyMap<string, RecipientInfo>;
  /** Names that have a `recipients/<name>.pub` file, valid or not. */
  readonly recipientFiles: ReadonlySet<string>;
  /** Owner name → its armored `recipients/<name>.identity.age`, for valid owner identity files. */
  readonly ownerIdentities: ReadonlyMap<string, string>;
  /** `<file>: <problem>` lines, as `agedrop check` prints them. */
  readonly problems: readonly string[];
}

/** The repository files a snapshot is built from. */
export interface RepositoryFiles {
  readonly config?: string;
  readonly lock?: string;
  /** Path → text for `recipients/*.pub`. */
  readonly recipients: ReadonlyMap<string, string>;
  /** Path → text for `recipients/*.identity.age`. */
  readonly identities?: ReadonlyMap<string, string>;
  /** Path → text for `requests/*.toml`. */
  readonly requests: ReadonlyMap<string, string>;
  /** Every file path under `secrets/`. */
  readonly secretPaths: readonly string[];
  /** Path → blob sha for the files under `secrets/`. */
  readonly secretShas?: ReadonlyMap<string, string>;
}

/** Reads the branch head from GitHub and builds its snapshot. */
export async function loadSnapshot(client: GitHubClient, branch?: string): Promise<Snapshot> {
  const repo = await client.repo();
  const ref = branch === undefined || branch === "" ? repo.defaultBranch : branch;
  const head = await client.head(ref);
  const tree = await client.tree(head);

  const blobs = tree.filter((entry) => entry.type === "blob");
  const shaOf = new Map(blobs.map((entry) => [entry.path, entry.sha]));
  const text = (path: string): Promise<string> | undefined => {
    const sha = shaOf.get(path);
    return sha === undefined ? undefined : client.blobText(sha);
  };
  const inDir = (dir: string, extension: string): string[] =>
    blobs
      .map((entry) => entry.path)
      .filter((path) => {
        const rest = path.slice(dir.length + 1);
        return (
          path.startsWith(`${dir}/`) &&
          !rest.includes("/") &&
          !rest.startsWith(".") &&
          rest.endsWith(extension)
        );
      });
  const readAll = async (paths: string[]): Promise<Map<string, string>> =>
    new Map(await limit(paths, async (path) => [path, (await text(path)) ?? ""] as const));

  const secretPaths = blobs
    .map((entry) => entry.path)
    .filter((path) => path.startsWith(`${SECRETS_DIR}/`))
    .filter((path) => !(path.split("/").pop() ?? "").startsWith("."));

  const [config, lock, recipients, identities, requests, history] = await Promise.all([
    text(CONFIG_FILE),
    text(LOCK_FILE),
    readAll(inDir(RECIPIENTS_DIR, RECIPIENT_EXTENSION)),
    readAll(inDir(RECIPIENTS_DIR, OWNER_IDENTITY_EXTENSION)),
    readAll(inDir(REQUESTS_DIR, ".toml")),
    limit(
      secretPaths.filter((path) => parseSecretPath(path) !== undefined),
      async (path) => [path, await client.lastChange(path, head)] as const,
    ),
  ]);
  const files: RepositoryFiles = {
    recipients,
    identities,
    requests,
    secretPaths,
    secretShas: new Map(secretPaths.map((path) => [path, shaOf.get(path) ?? ""])),
    ...(config === undefined ? {} : { config }),
    ...(lock === undefined ? {} : { lock }),
  };
  const lastChanges = new Map<string, LastChange>();
  for (const [path, change] of history) if (change !== undefined) lastChanges.set(path, change);
  return buildSnapshot(
    { repository: client.repository, branch: ref, head, canPush: repo.canPush },
    files,
    lastChanges,
  );
}

/** Validates the files and computes every status. Never throws on a malformed repository. */
export async function buildSnapshot(
  meta: { repository: string; branch: string; head: string; canPush: boolean },
  files: RepositoryFiles,
  lastChanges: ReadonlyMap<string, LastChange> = new Map(),
): Promise<Snapshot> {
  const problems: string[] = [];
  const attempt = <T>(fn: () => T): T | undefined => {
    try {
      return fn();
    } catch (error) {
      if (error instanceof FormatError) {
        for (const issue of error.issues) problems.push(`${error.file}: ${issue}`);
        return undefined;
      }
      throw error;
    }
  };

  let config: Config | undefined;
  if (files.config === undefined) problems.push(`${CONFIG_FILE}: missing`);
  else config = attempt(() => parseConfig(files.config ?? ""));

  const recipients = new Map<string, RecipientInfo>();
  const recipientFiles = new Set<string>();
  for (const [path, text] of files.recipients) {
    const name = path.slice(RECIPIENTS_DIR.length + 1, -RECIPIENT_EXTENSION.length);
    recipientFiles.add(name);
    const info = attempt(() => parseRecipientFile(name, text));
    if (info !== undefined) recipients.set(name, info);
  }
  const ownerIdentities = new Map<string, string>();
  for (const [path, text] of files.identities ?? []) {
    const name = path.slice(RECIPIENTS_DIR.length + 1, -OWNER_IDENTITY_EXTENSION.length);
    const pub = recipients.get(name) ?? (recipientFiles.has(name) ? "invalid" : undefined);
    const issues = ownerIdentityIssues(name, text, pub);
    for (const issue of issues) problems.push(`${path}: ${issue}`);
    if (issues.length === 0 && pub !== "invalid") ownerIdentities.set(name, text);
  }
  if (config !== undefined) {
    for (const issue of missingRecipients(config, recipients)) {
      problems.push(`${CONFIG_FILE}: ${issue}`);
    }
  }

  let lock: Lock | undefined =
    files.lock === undefined ? { secrets: new Map(), sets: new Map() } : undefined;
  if (files.lock !== undefined) {
    lock = attempt(() => parseLock(files.lock ?? ""));
    if (lock !== undefined) {
      for (const issue of await lockIssues(lock)) problems.push(`${LOCK_FILE}: ${issue}`);
    }
  }

  const scopes: ScopeView[] = [];
  const fingerprints = new Map<string, string>();
  for (const [scope, groups] of config?.scopes ?? []) {
    let resolved: ResolvedScope | undefined;
    if (config !== undefined && missingRecipients(config, recipients).length === 0) {
      resolved = attempt(() => resolveScope(config, recipients, scope));
    }
    if (resolved !== undefined) {
      fingerprints.set(scope, await recipientSetFingerprint(resolved.recipients));
    }
    scopes.push(resolved === undefined ? { scope, groups } : { scope, groups, resolved });
  }
  scopes.sort((a, b) => compareBytes(a.scope, b.scope));

  const secrets: SecretView[] = [];
  for (const path of [...files.secretPaths].sort(compareBytes)) {
    const parsed = parseSecretPath(path);
    if (parsed === undefined) {
      problems.push(`${path}: not secrets/<scope>/<NAME>.age`);
      continue;
    }
    const kind = secretKind(parsed.name);
    if (kind === undefined) continue;
    const expected = fingerprints.get(parsed.scope);
    const recorded = lock?.secrets.get(`${parsed.scope}/${parsed.name}`);
    const status: SecretStatus = !config?.scopes.has(parsed.scope)
      ? "unknown scope"
      : expected !== undefined && recorded === expected
        ? "ok"
        : "stale";
    const change = lastChanges.get(path);
    const sha = files.secretShas?.get(path);
    secrets.push({
      path,
      ...parsed,
      kind,
      status,
      ...(sha === undefined || sha === "" ? {} : { sha }),
      ...(change === undefined ? {} : { lastChange: change }),
    });
  }

  const requests: SecretRequest[] = [];
  for (const [path, text] of files.requests) {
    const id = path.slice(REQUESTS_DIR.length + 1, -".toml".length);
    const request = attempt(() => parseRequest(id, text));
    if (request === undefined) continue;
    if (config !== undefined && !config.scopes.has(request.scope)) {
      problems.push(`${path}: unknown scope "${request.scope}"`);
    }
    requests.push(request);
  }
  requests.sort((a, b) => compareBytes(b.created, a.created) || compareBytes(a.id, b.id));

  return {
    ...meta,
    ...(config === undefined ? {} : { config }),
    ...(lock === undefined ? {} : { lock }),
    scopes,
    secrets,
    requests,
    recipients,
    recipientFiles,
    ownerIdentities,
    problems,
  };
}

/** Runs `fn` over `items` with at most 8 calls in flight, keeping order. */
async function limit<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, items.length) }, worker));
  return results;
}

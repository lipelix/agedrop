import { execFile, spawn } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The last commit that touched a file. */
export interface Change {
  /** ISO 8601 author date. */
  readonly date: string;
  readonly author: string;
}

export interface GitInfo {
  /** Repository-relative path → its last commit. */
  readonly changes: ReadonlyMap<string, Change>;
  /** Repository-relative paths with changes git does not have yet (modified, added or untracked). */
  readonly dirty: ReadonlySet<string>;
}

/**
 * Asks git about the files under `dir` (relative to `root`, the agedrop repository).
 * Returns `undefined` when `root` is not in a git work tree or git is not installed.
 */
export async function gitInfo(root: string, dir: string): Promise<GitInfo | undefined> {
  let prefix: string;
  try {
    prefix = (await git(root, ["rev-parse", "--show-prefix"])).trim();
  } catch {
    return undefined;
  }
  const strip = (path: string): string | undefined =>
    path.startsWith(prefix) ? path.slice(prefix.length) : undefined;

  const changes = new Map<string, Change>();
  const log = await git(root, [
    "log",
    "--format=%x1e%aI%x1f%an",
    "--name-only",
    "--no-renames",
    "--",
    dir,
  ]).catch(() => ""); // a repository without commits has no log
  for (const record of log.split("\x1e")) {
    const [header, ...paths] = record.split("\n");
    if (header === undefined || header === "") continue;
    const [date, author] = header.split("\x1f");
    if (date === undefined || author === undefined) continue;
    for (const path of paths) {
      const relative = strip(path);
      if (relative !== undefined && relative !== "" && !changes.has(relative)) {
        changes.set(relative, { date, author });
      }
    }
  }

  const dirty = new Set<string>();
  const status = await git(root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--no-renames",
    "--untracked-files=all",
    "--",
    dir,
  ]);
  for (const entry of status.split("\0")) {
    if (entry.length < 4) continue;
    const relative = strip(entry.slice(3));
    if (relative !== undefined) dirty.add(relative);
  }
  return { changes, dirty };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-c", "core.quotePath=false", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

/** True when `root` is inside a git work tree and git is installed. */
export async function inWorkTree(root: string): Promise<boolean> {
  try {
    return (await git(root, ["rev-parse", "--is-inside-work-tree"])).trim() === "true";
  } catch {
    return false;
  }
}

/** True when git tracks `path` (relative to `root`) in its index. */
export async function isTracked(root: string, path: string): Promise<boolean> {
  try {
    await git(root, ["ls-files", "--error-unmatch", "--", path]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Commits exactly `paths` (relative to `root`; deleted files included) with `message`.
 * Other staged changes stay staged and out of the commit. Returns the new commit's short hash.
 */
export async function commitPaths(
  root: string,
  paths: readonly string[],
  message: string,
): Promise<string> {
  await git(root, ["add", "-A", "--", ...paths]);
  await git(root, ["commit", "--quiet", "--only", "-m", message, "--", ...paths]);
  return (await git(root, ["rev-parse", "--short", "HEAD"])).trim();
}

/**
 * Paths under `dir` (relative to `root`) that exist at `HEAD` and not at `rev`: `git diff --diff-filter=A`.
 * Fails when `root` is not in a git work tree or `rev` is not a commit git has.
 */
export async function addedSince(root: string, rev: string, dir: string): Promise<string[]> {
  const out = await git(root, [
    "diff",
    "--name-only",
    "--diff-filter=A",
    "--no-renames",
    "--relative",
    "-z",
    rev,
    "HEAD",
    "--",
    dir,
  ]);
  return out.split("\0").filter((path) => path !== "");
}

/** Where git's work tree starts, and the path from there to `dir` (`""` or ending in `/`). */
export interface WorkTree {
  readonly top: string;
  readonly prefix: string;
}

/** The work tree holding `dir`, or `undefined` outside one or without git. */
export async function workTree(dir: string): Promise<WorkTree | undefined> {
  try {
    const [top = "", prefix = ""] = (
      await git(dir, ["rev-parse", "--show-toplevel", "--show-prefix"])
    ).split("\n");
    return top === "" ? undefined : { top, prefix };
  } catch {
    return undefined;
  }
}

/** A file version that a commit would add: its path from the work tree's top and its blob. */
export interface FileVersion {
  readonly path: string;
  readonly blob: string;
}

/** The files staged for the next commit (added, modified or with a changed type), not deleted ones. */
export async function stagedFiles(top: string): Promise<FileVersion[]> {
  return parseRaw(
    await git(top, [
      "diff",
      "--cached",
      "--raw",
      "-z",
      "--no-renames",
      "--no-abbrev",
      "--no-ext-diff",
      "--diff-filter=AMT",
    ]),
  );
}

/**
 * Every file version that the commits in `rev..HEAD` add or change, each once. A `rev` of all zeros
 * means every commit reachable from `HEAD`. Fails when `rev` is not a commit git has.
 */
export async function committedFiles(top: string, rev: string): Promise<FileVersion[]> {
  const all = /^0+$/.test(rev);
  if (!all)
    await git(top, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`]);
  return parseRaw(
    await git(top, [
      "log",
      "--raw",
      "-z",
      "--no-renames",
      "--no-abbrev",
      "--format=",
      "--diff-filter=AMT",
      all ? "HEAD" : `${rev}..HEAD`,
      "--",
    ]),
  );
}

/** Parses `--raw -z` output (`:<mode> <mode> <blob> <blob> <status>\0<path>\0`), skipping submodules. */
function parseRaw(out: string): FileVersion[] {
  const seen = new Set<string>();
  const files: FileVersion[] = [];
  const fields = out.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const header = fields[i] ?? "";
    if (!header.startsWith(":")) continue;
    const path = fields[++i] ?? "";
    const [, mode = "", , blob = ""] = header.slice(1).split(" ");
    if (mode === "160000" || path === "") continue; // a submodule's commit, not a file
    const key = `${blob} ${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    files.push({ path, blob });
  }
  return files;
}

/**
 * Reads blobs with one `git cat-file --batch`, calling `onBlob` for each in order.
 * Only one blob is held in memory at a time.
 */
export async function readBlobs(
  top: string,
  blobs: readonly string[],
  onBlob: (blob: string, content: Buffer) => void,
): Promise<void> {
  if (blobs.length === 0) return;
  const child = spawn("git", ["cat-file", "--batch"], {
    cwd: top,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  const exit = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  child.stdin.on("error", () => {
    // git exiting early is reported through its exit code.
  });
  child.stdin.end(blobs.map((blob) => `${blob}\n`).join(""));

  // Chunks are joined only when a header or a whole blob is there, so a large blob is copied once.
  let chunks: Buffer[] = [];
  let length = 0;
  const joined = (): Buffer => {
    const all =
      chunks.length === 1 ? (chunks[0] ?? Buffer.alloc(0)) : Buffer.concat(chunks, length);
    chunks = [all];
    return all;
  };
  const keep = (rest: Buffer): void => {
    chunks = [rest];
    length = rest.length;
  };
  let header: { blob: string; size: number } | undefined;
  let index = 0;
  for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
    chunks.push(chunk);
    length += chunk.length;
    for (;;) {
      if (header === undefined) {
        const pending = joined();
        const end = pending.indexOf(10);
        if (end < 0) break;
        const line = pending.subarray(0, end).toString("utf8");
        keep(pending.subarray(end + 1));
        const [blob = "", type = "", size = ""] = line.split(" ");
        if (type !== "blob") throw new Error(`git cat-file: ${line}`);
        header = { blob, size: Number(size) };
        if (blob !== blobs[index]) throw new Error(`git cat-file: expected ${blobs[index] ?? ""}`);
      }
      if (length < header.size + 1) break;
      const pending = joined();
      onBlob(header.blob, pending.subarray(0, header.size));
      keep(pending.subarray(header.size + 1));
      header = undefined;
      index++;
    }
  }
  const code = await exit;
  if (code !== 0 || index !== blobs.length) {
    throw new Error(`git cat-file --batch failed: ${stderr.trim() || `exit ${String(code)}`}`);
  }
}

/** The paths (from the work tree's top) that an ignore rule covers, whether tracked or not. */
export async function ignoredPaths(top: string, paths: readonly string[]): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  const out = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      "git",
      ["check-ignore", "--no-index", "-z", "--stdin"],
      { cwd: top, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        // Exit 1 means none is ignored.
        if (error !== null && error.code !== 1) reject(new Error(error.message));
        else resolve(stdout);
      },
    );
    child.stdin?.on("error", () => {
      // Reported through the exit code.
    });
    child.stdin?.end(paths.map((path) => `${path}\0`).join(""));
  });
  return new Set(out.split("\0").filter((path) => path !== ""));
}

/** The pre-commit hook's absolute path, following `core.hooksPath` and linked worktrees. */
export async function preCommitHookPath(top: string): Promise<string> {
  return resolve(top, (await git(top, ["rev-parse", "--git-path", "hooks/pre-commit"])).trim());
}

import { execFile } from "node:child_process";
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

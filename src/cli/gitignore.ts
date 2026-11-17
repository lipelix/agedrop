import { appendFile, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { readOptional } from "../node.js";
import { type Context, note } from "./context.js";
import { ignoredPaths, isTracked, workTree } from "./git.js";

/** What `init` and `protect` keep out of git: env files and identities (SPEC.md § `protect`). */
export const PROTECT_IGNORES: readonly string[] = [
  ".env",
  ".env.*",
  "!.env.example",
  "identity",
  "*.identity",
];

/**
 * Appends to `<dir>/.gitignore`, creating it, the `lines` it does not have yet, under `comment`.
 * Returns the lines added.
 */
export async function addIgnores(
  dir: string,
  lines: readonly string[],
  comment: string,
): Promise<string[]> {
  const path = join(dir, ".gitignore");
  const text = (await readOptional(path)) ?? "";
  const present = new Set(text.split(/\r?\n/).map((line) => line.trim()));
  const missing = lines.filter((line) => !present.has(line));
  if (missing.length === 0) return [];
  const separator = text === "" ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  await appendFile(path, `${separator}# ${comment}\n${missing.join("\n")}\n`, { mode: 0o644 });
  return missing;
}

/**
 * For files `pull` wrote that are inside a git work tree: adds those no ignore rule covers to the
 * `.gitignore` next to them, and warns about those git tracks (SPEC.md § `pull`).
 */
export async function keepOutOfGit(ctx: Context, files: readonly string[]): Promise<void> {
  const byDir = new Map<string, string[]>();
  for (const file of files) {
    byDir.set(dirname(file), [...(byDir.get(dirname(file)) ?? []), basename(file)]);
  }
  for (const [dir, names] of byDir) {
    const tree = await workTree(dir);
    if (tree === undefined) continue;
    const real = await realpath(dir);
    const paths = names.map((name) => relative(tree.top, join(real, name)).split(sep).join("/"));
    const ignored = await ignoredPaths(tree.top, paths);
    const added = await addIgnores(
      dir,
      names.filter((_, i) => !ignored.has(paths[i] ?? "")).map((name) => `/${escapePattern(name)}`),
      "agedrop pull: decrypted values, never commit them",
    );
    if (added.length > 0) {
      note(
        ctx,
        `added ${added.join(" ")} to ${join(dir, ".gitignore")}, so git add skips the values`,
      );
    }
    for (const path of paths) {
      if (await isTracked(tree.top, path)) {
        note(
          ctx,
          `agedrop: warning: git tracks ${path}: its next commit would hold the decrypted values (git rm --cached ${path})`,
        );
      }
    }
  }
}

/** A file name as a `.gitignore` pattern that matches only that name. */
function escapePattern(name: string): string {
  return name.replace(/[\\*?[\]!# ]/g, "\\$&");
}

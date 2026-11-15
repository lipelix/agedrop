import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { CONFIG_FILE } from "../names.js";
import { loadRepository, type Repository } from "../node.js";
import { resolveScope, type ResolvedScope } from "../scope.js";
import { CliError, type Context } from "./context.js";

/**
 * The repository root: `--repo` when given, else the nearest directory from the current one
 * upwards that holds `agedrop.toml`. Returns `undefined` when there is none and `--repo` was not given.
 */
export async function findRoot(
  ctx: Context,
  repo: string | undefined,
): Promise<string | undefined> {
  if (repo !== undefined) {
    const root = resolve(ctx.cwd, repo);
    if (!(await exists(join(root, CONFIG_FILE)))) {
      throw new CliError(`${root}: no ${CONFIG_FILE} here (run agedrop init)`);
    }
    return root;
  }
  let dir = resolve(ctx.cwd);
  for (;;) {
    if (await exists(join(dir, CONFIG_FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Like {@link findRoot}, but fails outside a repository. */
export async function requireRoot(ctx: Context, repo: string | undefined): Promise<string> {
  const root = await findRoot(ctx, repo);
  if (root === undefined) {
    throw new CliError(
      `not in an agedrop repository: no ${CONFIG_FILE} in ${ctx.cwd} or its parents (run agedrop init, or pass --repo <dir>)`,
    );
  }
  return root;
}

/** Finds and loads the repository: `agedrop.toml` plus every recipient it names. */
export async function openRepository(ctx: Context, repo: string | undefined): Promise<Repository> {
  return loadRepository(await requireRoot(ctx, repo));
}

/** Resolves a scope, failing with the list of defined scopes when it is unknown. */
export function scopeOf(repo: Repository, scope: string): ResolvedScope {
  if (!repo.config.scopes.has(scope)) throw unknownScope(repo, scope);
  return resolveScope(repo.config, repo.recipients, scope);
}

export function unknownScope(repo: Repository, scope: string): CliError {
  const known = [...repo.config.scopes.keys()].sort();
  return new CliError(
    `unknown scope "${scope}": ${
      known.length === 0
        ? `${CONFIG_FILE} defines no scopes yet`
        : `${CONFIG_FILE} defines ${known.map((s) => `"${s}"`).join(", ")}`
    }`,
  );
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * A filter for `scope` and the scopes nested in it, or every scope when `scope` is undefined.
 * Fails when no scope defined in `agedrop.toml` matches.
 */
export function scopeFilter(repo: Repository, scope: string | undefined): (s: string) => boolean {
  const inScope = (s: string): boolean =>
    scope === undefined || s === scope || s.startsWith(`${scope}/`);
  if (scope !== undefined && ![...repo.config.scopes.keys()].some(inScope)) {
    throw unknownScope(repo, scope);
  }
  return inScope;
}

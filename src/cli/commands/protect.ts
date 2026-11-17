import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { readOptional, writeFileAtomic } from "../../node.js";
import type { Command } from "../command.js";
import { parse } from "../command.js";
import { CliError, note, UsageError } from "../context.js";
import { preCommitHookPath, workTree } from "../git.js";
import { addIgnores, PROTECT_IGNORES } from "../gitignore.js";
import { HOOK_MARKER, preCommitHook } from "../hook.js";
import { requireRoot } from "../repo.js";

export const protect: Command = {
  name: "protect",
  summary: "install a pre-commit hook that refuses plaintext secrets",
  help: `usage: agedrop protect [--force] [--repo <dir>]

Installs a git pre-commit hook that runs agedrop check --staged, so a commit
with plaintext under secrets/, an age private key or an unignored .env file is
refused. The hook goes where git looks for it (core.hooksPath is followed) and
needs agedrop on PATH. Also adds .env, .env.*, identity and *.identity to
.gitignore when they are missing.
  --force  replace a pre-commit hook that agedrop did not write
Skip the hook once with git commit --no-verify; agedrop init --ci github runs
the same check in CI, which catches that too.`,
  async run(ctx, args) {
    const { values, positionals } = parse(args, {
      force: { type: "boolean" },
      repo: { type: "string" },
    });
    if (positionals.length > 0)
      throw new UsageError(`unexpected argument "${positionals[0] ?? ""}"`);
    const root = await requireRoot(ctx, values.repo);
    const tree = await workTree(root);
    if (tree === undefined) {
      throw new CliError(`${root} is not in a git work tree: run git init first`);
    }
    const hook = await preCommitHookPath(tree.top);
    const existing = await readOptional(hook);
    const ours = existing?.includes(HOOK_MARKER) === true;
    if (existing !== undefined && !ours && values.force !== true) {
      throw new CliError(
        `${hook} already exists and agedrop did not write it: add "agedrop check --staged" to it, or pass --force to replace it`,
      );
    }
    await mkdir(dirname(hook), { recursive: true });
    await writeFileAtomic(hook, preCommitHook(tree.prefix), { mode: 0o755 });
    note(
      ctx,
      `${existing === undefined ? "installed" : ours ? "updated" : "replaced"} ${hook}: commits run agedrop check --staged`,
    );
    const added = await addIgnores(
      root,
      PROTECT_IGNORES,
      "agedrop: decrypted values and identities",
    );
    if (added.length > 0) note(ctx, `added to .gitignore: ${added.join(" ")}`);
    return 0;
  },
};

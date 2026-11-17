/** The line that marks a pre-commit hook as written by `agedrop protect`. */
export const HOOK_MARKER = "# agedrop pre-commit hook, written by agedrop protect.";

/**
 * The pre-commit hook: plain `sh` that runs `agedrop check --staged`. git runs hooks from the top of
 * the work tree, so `prefix` (the path from there to the agedrop directory) becomes `--repo`.
 */
export function preCommitHook(prefix: string): string {
  const repo = prefix.replace(/\/$/, "");
  const args = repo === "" ? "" : ` --repo ${shellQuote(repo)}`;
  return `#!/bin/sh
${HOOK_MARKER}
# Refuses a commit that holds plaintext under secrets/, an age private key or a
# .env file that no ignore rule covers. Skip it once with: git commit --no-verify
if ! command -v agedrop >/dev/null 2>&1; then
  echo "agedrop pre-commit hook: agedrop is not on PATH, so the staged files were not checked." >&2
  echo "Install it (npm install --global agedrop), or skip the hook once with git commit --no-verify." >&2
  exit 1
fi
exec agedrop check --staged${args}
`;
}

function shellQuote(text: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;
}

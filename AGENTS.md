# agedrop

Secrets as age files in git: write with public keys only, read with a private key, agents request and never see values.

- `SPEC.md` is the format. Change it before code, and keep it in sync.
- `docs/decisions.md` records why things are the way they are. Append, don't rewrite.
- Never commit plaintext secrets, real identities or private keys, including in tests (generate throwaway keys).
- This repo is public. Commits, issues, PRs, comments and CI logs must not name the maintainer's employer, machines,
  home network, local paths, usernames, notification topics or webhook URLs. Removing such a detail later does not
  help: commit diffs, PR refs and comment edit history keep it. Leave it out from the start.
- Every secret file must decrypt with the stock `age` CLI. Compatibility tests guard this.
- Commits: Conventional Commits in English.

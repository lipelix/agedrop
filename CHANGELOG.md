# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/). Until v1, a minor version may break the format or
the CLI; such changes are marked **Breaking**.

## [Unreleased]

### Added

- `agedrop protect` installs a git pre-commit hook that runs `check --staged`, which refuses a commit holding
  plaintext under `secrets/`, an age private key or a `.env` / `.env.*` file no ignore rule covers; `--values`
  also looks for every value the host can decrypt. `check --since <rev>` checks every commit since `<rev>`, and
  `init --ci github` writes `.github/workflows/agedrop-check.yml`, which runs it on pull requests and pushes to
  the default branch, catching `--no-verify` and commits made on the web. Messages name the file and the
  reason, never the value.
- `init` and `protect` add `.env`, `.env.*`, `identity` and `*.identity` to `.gitignore`; `pull` adds the files it
  writes inside a git work tree to the `.gitignore` next to them and warns about ones git tracks.
- `exec --redact` replaces the scope's values in the command's stdout and stderr with `[REDACTED:<NAME>]`,
  also their URL-encoded, JSON-escaped and base64 forms, so a command an agent runs cannot print them into its
  transcript. `redact = true` on a scope in `agedrop.toml` makes it the default there and refuses `--no-redact`.
  `ls` and `check` warn about values too short to redact (under 6 bytes).

- Web UI: sign in to several repositories on one device. The repository name in the top bar opens
  **Repositories**, which switches, adds and removes them; a signed-in repository's token can serve the next
  one, since a fine-grained token can cover several repositories of an owner. A notification's link opens its
  repository by itself when the device is signed in to it.

### Changed

- Web UI: the sign-in form checks the token against GitHub before storing it.
- `init --ci github` in a repository with one of its workflows writes the other and leaves the existing one as it
  is; it fails only when both exist.
- **Breaking:** `add` and `fulfil` remove trailing newlines from an env-style value read from stdin, as the
  `--generate` path already did, so `agedrop fulfil <id> < token-file` stores the token without the file's
  newline. File-style values still keep their exact bytes.
- The CLI no longer prints Node's experimental-feature warning for X25519 on every command.
- Web UI: the new-token link names the token `agedrop web (<owner>)`, since GitHub token names are unique per
  account; a taken name means a token for that owner exists, and the form says to widen it instead.
- Web UI: a store fresh from `init`, whose owner has no key yet, shows "Set up the key of <owner>" with a
  button to the Owner page instead of listing it as a problem.
- Web UI: the owner backup marks the private key line, dims the comments, says that `# public key` is not
  secret, and asks to store the file with Copy or Download rather than a screenshot.
- Web UI: **Save in Passwords** stores the owner backup in the browser's passwords in one tap, and
  **Unlock with the backup** fills it from there; a whole identity file pasted into the one-line field works.

## [0.1.0] - 2026-11-14

First release. The format is draft v0 ([SPEC.md](SPEC.md)).

### Added

- Format library: `agedrop.toml`, recipients, one armored age file per secret, `agedrop.lock` with recipient-set
  fingerprints, requests and owner identity files. Every secret decrypts with the stock `age` CLI.
- CLI: `init`, `keygen`, `add`, `ls`, `check`, `pull`, `exec`, `request`, `requests`, `fulfil`, `rekey` and
  `notify`.
- Requests: an agent asks for a secret with no value and no key; `fulfil` encrypts the answer and closes the
  request in one commit.
- `agedrop notify` and the workflow from `agedrop init --ci github`: new requests go to ntfy, a signed webhook or
  Web Push.
- Static web UI (`web/`): inventory, add and fulfil with a fine-grained GitHub token, and reading values with an
  owner identity wrapped by a passkey.

[Unreleased]: https://github.com/lipelix/agedrop/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/lipelix/agedrop/releases/tag/v0.1.0

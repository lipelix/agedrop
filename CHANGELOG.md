# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/). Until v1, a minor version may break the format or
the CLI; such changes are marked **Breaking**.

## [Unreleased]

## [0.1.0] - 2026-11-18

First release. The format is draft v0 ([SPEC.md](SPEC.md)).

### Added

- Format library: `agedrop.toml`, recipients, one armored age file per secret, `agedrop.lock` with recipient-set
  fingerprints, requests and owner identity files. Every secret decrypts with the stock `age` CLI.
- CLI: `init`, `keygen`, `add`, `ls`, `check`, `pull`, `exec`, `protect`, `request`, `requests`, `fulfil`, `rekey`
  and `notify`. `add` and `fulfil` remove trailing newlines from an env-style value read from stdin; file-style
  values keep their exact bytes.
- Requests: an agent asks for a secret with no value and no key; `fulfil` encrypts the answer and closes the
  request in one commit.
- `exec --redact` replaces the scope's values in the command's stdout and stderr with `[REDACTED:<NAME>]`,
  also their URL-encoded, JSON-escaped and base64 forms, so a command an agent runs cannot print them into its
  transcript. `redact = true` on a scope in `agedrop.toml` makes it the default there and refuses `--no-redact`.
  `ls` and `check` warn about values too short to redact (under 6 bytes).
- `agedrop protect` installs a git pre-commit hook that runs `check --staged`, which refuses a commit holding
  plaintext under `secrets/`, an age private key or a `.env` / `.env.*` file no ignore rule covers; `--values`
  also looks for every value the host can decrypt. `check --since <rev>` checks every commit since `<rev>`.
  Messages name the file and the reason, never the value.
- `init` and `protect` add `.env`, `.env.*`, `identity` and `*.identity` to `.gitignore`; `pull` adds the files it
  writes inside a git work tree to the `.gitignore` next to them and warns about ones git tracks.
- `init --ci github` writes `.github/workflows/agedrop-requests.yml`, which sends new requests to ntfy, a signed
  webhook or Web Push through `agedrop notify`, and `.github/workflows/agedrop-check.yml`, which runs
  `check --since` on pull requests and pushes to the default branch, catching `--no-verify` and commits made on
  the web. With one of them present it writes the other.
- Static web UI (`web/`): inventory, add and fulfil with a fine-grained GitHub token checked against GitHub at
  sign-in, several repositories on one device, and reading values with an owner identity wrapped by a passkey.
  The owner backup can be saved in the browser's passwords and unlocks the identity when the passkey is not at
  hand.

[Unreleased]: https://github.com/lipelix/agedrop/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/lipelix/agedrop/releases/tag/v0.1.0

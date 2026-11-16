# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/). Until v1, a minor version may break the format or
the CLI; such changes are marked **Breaking**.

## [Unreleased]

### Added

- Web UI: sign in to several repositories on one device. The repository name in the top bar opens
  **Repositories**, which switches, adds and removes them; a signed-in repository's token can serve the next
  one, since a fine-grained token can cover several repositories of an owner. A notification's link opens its
  repository by itself when the device is signed in to it.

### Changed

- Web UI: the sign-in form checks the token against GitHub before storing it.

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

# Security policy

agedrop handles secrets, so reports are welcome and handled first.

## Report a vulnerability

Use GitHub's private reporting: **Security → Report a vulnerability** on
[lipelix/agedrop](https://github.com/lipelix/agedrop/security/advisories/new). Do not open a public issue for a
vulnerability.

Include the version (`agedrop --version`), what an attacker needs (push access, a stolen token, a process on the
host…) and what they gain, and steps or a test that shows it. Never send real secrets or private keys; generate
throwaway keys with `age-keygen`.

You get an answer within 7 days. A fix is released as a new patch version with a GitHub security advisory, and you
are credited unless you ask not to be.

## Supported versions

Only the latest release gets fixes until v1.

## Scope

In scope: the format library and CLI (`src/`), the web UI (`web/`, served at app.agedrop.dev), the workflow that
`agedrop init --ci github` writes, and the format in `SPEC.md`.

Known limits, not vulnerabilities (see [SPEC.md § Security notes](SPEC.md#security-notes)):

- anyone with push access can replace (not read) a secret or a recipient's public key;
- old commits stay readable with a recipient key that was later removed;
- a process running as the same OS user as a host identity can read that host's secrets;
- there is no read audit.

The cryptography is [age](https://age-encryption.org) via
[typage](https://github.com/FiloSottile/typage). Problems in age itself belong upstream.

## Verify a release

Every npm release is built and published by
[the release workflow](.github/workflows/release.yml) with npm provenance. Check it with
`npm audit signatures` in a project that depends on agedrop, or on the package page on npmjs.com.

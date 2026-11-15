# Decisions

## 2026-11-09 — Why agedrop exists

**Context.** A home server held its secrets in about ten scattered `.env` files and secret directories, with no backup.
Keys were copied by hand between machines. Automated agent sessions stalled on manual "owner, add this secret" steps.

**Options considered.**

| Option | Cost | Why not (alone) |
|---|---|---|
| Infisical Cloud Free | $0 | 5 identities total, counting humans and machines. No secret versioning or rotation on Free. Pro is $20 per identity per month. |
| Infisical / Phase self-hosted (e.g. Hetzner VPS) | VPS | Another server to patch and back up. Has its own bootstrap secrets. Services can't start when it is down. |
| Phase Cloud Free | $0 | 5 users or service accounts, 3 apps, 24 h audit log. |
| SOPS + age | $0 | Adding a value needs the data key, so a private key. No UX for requests. |
| dotenvx | $0 | Public-key-only writes for `.env`, but no web UI and no request flow. |

Pricing is from infisical.com/pricing and phase.dev/pricing, read 2026-11-09.

**Decision.** Build agedrop: age files in git, writes need public keys only, a static web UI, and a request flow for agents.
Phase and Infisical already ship agent features (Phase Agents Relay, Infisical Agent Vault). agedrop differs in three ways:
no backend, an open file format, and an agent never receives the value.

## 2026-11-09 — Where the code lives

- **`lipelix/agedrop`** (this repo): spec, CLI, static web UI, adapters. MIT. Trust in a security tool's core rests
  on a named maintainer with history.
- **`liplab-tech/*`**: optional paid hosted pieces, added later. They use the core as a normal dependency, with no private hooks in it.
- Package names, install URLs and docs do not depend on the GitHub owner (`agedrop.dev`, unscoped npm `agedrop`),
  so the core can move to an org later without breaking users.

## 2026-11-09 — Monetization (later, after open-source validation)

Free and open source: everything that works without a server. Paid: only what genuinely needs one.
- Hosted relay for requests: notifications and mobile approval. It only ever sees ciphertext.
- Teams: one-click offboarding (rekey plus a rotation checklist), approval policies, SSO.
- Delivery audit and a rotation scheduler. Rotation itself runs in the customer's CI.

Sell through a merchant of record, which handles EU VAT. Keep paid code out of this repo, with no `ee/` directory.
Before any paid feature: check trademarks (EUIPO/USPTO).

## 2026-11-14 — No pricing for now: free, open-source core only

The monetization plan from 2026-11-09 is shelved. agedrop stays a free, MIT-licensed core with no paid plans, and
the landing page shows no prices or planned paid tiers (the proposed Relay and Teams tiers are gone from it). Hosted
extras such as a relay or team features are not planned. If that changes, it gets a new entry here, and the
trademark check above still applies first.

## 2026-11-14 — Implementation language: TypeScript with typage

**Decision.** One TypeScript implementation of the format, shared by the CLI and the static web UI, built on
[`age-encryption`](https://github.com/FiloSottile/typage) (typage, by age's author). Every secret file must still
decrypt with the Go `age` CLI, and files written by `age` must decrypt with the library; compatibility tests run
against a real `age` binary in CI to guard both directions.

**Why.** The web UI has to encrypt (and, for owners, decrypt) in the browser with no backend, so a browser
implementation is needed anyway. Go would give the CLI a single static binary but would mean a second
implementation of the format for the browser, and two implementations drift.

**Details.**
- Node 22.12 or newer, ESM only, strict TypeScript. TypeScript stays on 6.0 until typescript-eslint supports 7.
- The format core (`src/`, exported as `agedrop`) does no I/O, so it runs unchanged in the browser.
  Filesystem helpers live in `agedrop/node`.
- TOML is parsed with `smol-toml` (small, no dependencies, TOML 1.0, works in the browser).
- `agedrop.toml` rejects unknown keys: a typo such as `recipient = [...]` must fail, not encrypt to fewer people.
- The lock fingerprint hashes age recipient strings, not names, so replacing a machine's key flags its secrets
  for rekey while renaming a recipient does not.

## 2026-11-14 — CLI shape

**Decision.** The CLI (`agedrop`, `src/cli/`) has no dependencies beyond the format library: arguments are
parsed with `node:util` `parseArgs`. Details in SPEC.md § Operations.

- **Values come from stdin as exact bytes**, never from arguments (they would land in shell history and `ps`).
  From a terminal, `add` reads one line without echo. A trailing newline from `echo` is kept, with a warning,
  because the spec stores exact bytes.
- **Identity order:** `--identity <file>`, then `AGEDROP_IDENTITY` (the key itself, as CI secrets hold values,
  not paths), then `~/.config/agedrop/identity`. An empty `AGEDROP_IDENTITY` is an error, not "unset":
  GitHub Actions expands a missing secret to an empty string.
- **Output discipline:** values and identities go to stdout only when the destination is `-`. Messages go
  to stderr, so `pull --to -` and `keygen --out -` can be piped.
- **`exec` and `pull --env` only carry env-style names** (`FOO_BAR`). File-style values (keys, certificates)
  are skipped with a note; `pull --to <dir>` writes them.
- **`pull` and `exec` read only `secrets/<scope>/`, not nested scopes**, so `mini` never hands `mini/hq`'s
  values to a process that asked for `mini`.
- **`check` never decrypts**, so it can gate pull requests in CI without an identity.
- **Error messages never echo key material:** a private key pasted into `recipients/*.pub` is reported without its value.

## 2026-11-14 — Requests, fulfil and rekey

**Decision.** Details in SPEC.md § Operations; the guide for agent authors is `docs/agents.md`.

- **`agedrop.lock` keeps each recipient set's keys** (`[sets]`, fingerprint → name = key), not only the
  fingerprint. Without it `rekey` cannot tell which keys could read a file before, and so cannot list the
  secrets to rotate once a `.pub` file is gone. The keys are public anyway. Writers drop unused sets.
- **`request` is idempotent per secret** (an open request for the same scope and name is reused) and does not
  commit: agents commit and push their own work. It takes no value and reads no stdin.
- **`fulfil` commits exactly its paths** (`git commit --only`), so unrelated staged changes never ride along
  with a secret, and it does not push: pushing stays a human decision.
- **The `generate` hint is untrusted.** It comes from whoever filed the request. `fulfil` shows it and runs it
  only after a "y" at a terminal or with `--generate`, and never prints its output.
- **`rekey` re-encrypts only stale secrets by default** (`--all` for every one), so a routine run gives a
  small diff. It refuses identities outside the `owners` group even when they could decrypt, because rekeying
  is the owner's call. It does not commit, so the owner reviews the diff first.
- **A secret whose previous recipients are unknown is listed for rotation**: when in doubt, rotate.

## 2026-11-14 — Web UI: a pasted fine-grained token, no token-exchange Worker

**Context.** The static web UI (`web/`) has to read and commit to the repository through the GitHub API. GitHub's
OAuth web flow ends in a token exchange that needs the client secret and is not CORS-enabled, so a page alone
cannot finish it. SPEC.md open question 2 listed two ways out.

| Option | For | Against |
|---|---|---|
| Fine-grained PAT pasted into the page | nothing to run or deploy; the token is limited to one repository and *Contents*, with an expiry | made by hand on github.com; lives in the browser's storage |
| Stateless Cloudflare Worker for the OAuth exchange | one-tap "Sign in with GitHub" | a server after all, an OAuth app and its client secret to keep, and the Worker sees every user token; classic OAuth app tokens cannot be limited to one repository |

**Decision.** The pasted token. "No backend" is the point of agedrop, and the narrower token is the safer
one. The sign-in form links to GitHub's token page with the name and permission filled in.

**Details.**
- `sessionStorage` by default, `localStorage` only with "Remember on this device".
- The app is served from its own origin, `app.agedrop.dev`, so nothing on the landing page shares its storage.
  It loads no third-party code (no web fonts or analytics), and its CSP allows `connect-src https://api.github.com` only.
- Commits go through GraphQL `createCommitOnBranch` with `expectedHeadOid`: one atomic commit per action (the
  secret, `agedrop.lock` and the deleted request together), and a concurrent push fails the write instead of
  being overwritten.
- Reads use REST (ref, recursive tree, blobs, and the last commit per secret), which keeps the test double for
  GitHub small.
- The request's `generate` hint is shown, never run: a browser cannot run a shell command, and the hint is
  untrusted. A "Generate" button makes a random value in the browser instead.

## 2026-11-14 — Web UI hosting and its tests

- **Cloudflare Pages, direct upload from CI.** `.github/workflows/deploy-web.yml` builds `web/` and runs
  `wrangler pages deploy` to the project `agedrop-app` on every push to `main` that touches the app.
  Cloudflare never builds the repository, so it needs no access to it. The project, the `app.agedrop.dev`
  domain and DNS record, and the repository's `CLOUDFLARE_API_TOKEN` secret and `CLOUDFLARE_ACCOUNT_ID`
  variable are OpenTofu in `infra/` (Terraform Cloud state, as in lipelix/zmrdly), applied by the owner with
  a token from the personal Cloudflare account. CI's token can edit Pages and nothing else.
- **The browser tests run on the self-hosted runners** (WebKit as an iPhone 15, and Chromium), which install the
  browsers with `playwright install --with-deps`: the runners run as root on Ubuntu but have no Docker daemon for
  job containers. GitHub is replaced by an in-memory
  double (`test/fake-github.ts`), and each test records every request the page sends to any host.
- **Checked once against the real API (2026-11-14):** a throwaway branch with throwaway keys, fulfilled from
  the built page in WebKit and Chromium with a real token. Each fulfil was one commit (lock modified, request
  removed, secret added), the stock `age` decrypted it with the host key, and GitHub marked the commit
  *Verified*: `createCommitOnBranch` commits are signed by GitHub, which helps the "signed commits" advice.

## 2026-11-14 — Owner passkey: an X25519 key wrapped by a passkey, set up in the browser

**Context.** An owner should read a value from a phone after Face ID, with no backend. typage can encrypt
straight to a passkey (`WebAuthnRecipient`, WebAuthn PRF), but such a file needs that passkey: the stock `age`
CLI cannot read it without a plugin.

| Option | For | Against |
|---|---|---|
| Passkey as a recipient of every secret | one less file | secrets stop decrypting with stock `age`; adding a secret would need the passkey, breaking "writes need public keys only" |
| X25519 owner key, wrapped by the passkey in `recipients/<name>.identity.age` | secrets stay plain X25519 age files; writes stay public-key only; an offline backup of the key reads everything | one more file, and the backup is a private key to keep safe |
| Passphrase (scrypt) wrapping | works in every browser | a typed secret on a phone, and guessable offline from the public repository |

**Decision.** The wrapped X25519 key. The passkey only ever protects the owner key; every secret is still
encrypted to the owner's `age1…` recipient and decrypts with `age -d -i <backup>`.

**Details.**
- **PRF on iPhone Safari** (checked 2026-11-14 from WebKit and vendor reports, not on a device): Safari supports
  PRF for iCloud Keychain passkeys from iOS 18 and macOS 15, with a data-loss bug in iOS 18.0–18.3 fixed in 18.4.
  Third-party password managers and the cross-device (QR) flow may not support it. So no passphrase fallback:
  the **backup is the fallback**, and the page unlocks with a pasted backup too. Reports also warn against PRF
  as the only key to data; the mandatory backup covers that.
- **The setup runs in the browser**, because passkeys exist only there. There is no `agedrop owner init` CLI
  command; `keygen --kind owner` still makes a file-based owner key, and the web UI can wrap it.
- **Each passkey ceremony is its own tap** (create, then wrap): Safari allows one WebAuthn call per user gesture.
- **Discoverable passkeys, no stored credential ID.** typage's `AGE-PLUGIN-FIDO2PRF-1…` string is not kept: the
  browser lists the passkeys for `app.agedrop.dev`, and the page checks the unwrapped key against `<name>.pub`.
- **The relying party is the app's host name**, so the landing page on `agedrop.dev` cannot use the passkey.
- **One passkey per owner file.** Setting up again replaces it; passkeys synced through iCloud Keychain or
  Google Password Manager cover several devices of one person.
- **The page keeps the key in memory for 5 minutes** and a shown value for 30 seconds; nothing goes to storage.
- **Tests**: a fake PRF authenticator (`test/fake-passkey.ts`) runs the flow in Node, WebKit and Chromium, and
  Chromium's CDP virtual authenticator (`hasPrf`) runs it with real WebAuthn. A real iPhone is still to be
  checked by hand once the app is deployed.

## 2026-11-14 — Request notifications: a CLI command, run by a generated workflow

**Context.** A human should learn about a new request without a backend (SPEC open question 3). The targets are
ntfy (phone, no account), a generic webhook, and Web Push for apps like HQ that already have subscriptions.

| Option | For | Against |
|---|---|---|
| A reusable workflow or composite action in this repository (`uses: lipelix/agedrop/…@v0`) | one line in the user's repository | does not work while this repository is private; Web Push in YAML and shell is not testable; a moving tag runs new code with the user's secrets |
| `agedrop notify`, and `init --ci github` writes a workflow that runs it | one implementation, tested with the rest of the CLI; runs in any CI and by hand; the version is pinned in the file | the workflow is a copy, so upgrading means editing one version number |
| A GitHub App or a Worker that watches pushes | no CI minutes | a backend |

**Decision.** `agedrop notify` plus a generated workflow. The workflow pins `agedrop@<version>` of the CLI that
wrote it, needs only `contents: read`, passes `github.event.before` through an environment variable (not into
the script), and runs only on the default branch, where the web UI looks for requests.

**Details.**
- **Which requests.** `--since <rev>` lists the request files added between the push's previous commit and `HEAD`
  with `git diff --diff-filter=A`, so each request is announced once, also when a push has several commits. The
  checkout fetches the whole history so the previous commit is there.
- **No dependency for Web Push.** RFC 8291 (aes128gcm) and the VAPID JWT (RFC 8292) are about 150 lines on
  `node:crypto`. Tests decrypt the result with `http_ece`, the decryptor the `web-push` library uses, and verify
  the JWT. Payloads are one 4096-byte record.
- **ntfy's JSON publishing** (`POST` to the server with `topic` in the body) instead of headers: the title and the
  reason can be any Unicode, which HTTP headers cannot carry as is.
- **Errors never show a target's URL.** An ntfy topic on ntfy.sh is its only secret, and a webhook URL often holds a
  token, so failures name the target kind and the HTTP status only.
- **The link carries the repository** (`#/requests/<id>?repo=<owner/name>`): the web UI fills it in at sign-in, and
  says so when it is signed in to another repository instead of reporting a missing request.
- **Checked live (2026-11-14):** a throwaway orphan branch of this repository held a repository made with
  `agedrop init --owner owner --ci github` and the generated workflow, changed only to run on a
  self-hosted runner, on that branch, from the packed CLI (`npm pack`, as npm is not published yet) and with a
  random ntfy.sh topic. Pushing a request made with `agedrop request` gave an ntfy.sh message with the title,
  reason, requester and fulfil link **11 seconds** after the push (job: 12 s). The branch was deleted afterwards.

## 2026-11-14 — Release v0.1: npm with provenance from a signed tag

**Context.** v0.1 should be a package people can trust: built in CI, traceable to a commit, and released by
the maintainer on purpose. The repository's CI runs on self-hosted runners because the Actions budget of the
private repository is exhausted.

**Decision.**
- **A pushed signed tag `v<version>` releases.** `.github/workflows/release.yml` refuses a lightweight tag, a tag
  whose signature GitHub does not verify, a tag that does not match `package.json`, and a version with no
  `CHANGELOG.md` section. Signing stays on the maintainer's machine; CI holds no signing key.
- **npm provenance (Sigstore) on a GitHub-hosted runner.** npm generates provenance only on cloud-hosted runners
  and only for public source repositories, so the release job ignores `RUNNER_LABELS`. Hosted runners are free for
  public repositories, so this costs nothing once the repository is public, and the first release has to wait
  for that.
- **`NPM_TOKEN` for the first publish, trusted publishing after.** A trusted publisher is configured on an existing
  package, so 0.1.0 goes out with a granular token. Afterwards a trusted publisher for `release.yml` replaces the
  token (npm 11.5.1 or newer, which the job installs, uses OIDC when no token is set).
- **The job checks the published package** with `npx agedrop@<version> init` in an empty directory, the same
  check as the release's "done when".
- **Vulnerability reports go through GitHub private vulnerability reporting**, not an e-mail address: it needs no
  mail setup on agedrop.dev and keeps the report next to the advisory and the fix.
- **The package ships `dist/` without source maps.** The maps point at `src/`, which is not in the package.

## 2026-11-14 — Landing page hosting on agedrop.dev

**Context.** The landing page in `site/` had no host. The app already has its own Pages project and origin,
`app.agedrop.dev`, so nothing on the landing page shares its storage or its passkeys.

**Decision.**
- **A second Pages project, `agedrop-site`, on the apex**, uploaded directly from CI like the app:
  `.github/workflows/deploy-site.yml` copies `site/` without `site/.hallmark/` (design notes, not part of the page)
  and runs `wrangler pages deploy` on every push to `main` that touches `site/`. It reuses the app's
  `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`: the token can edit any Pages project in the account and
  nothing else, so a second token would add no isolation.
- **`www.agedrop.dev` is a 301 to the apex** with a Single Redirect rule (the zone's
  `http_request_dynamic_redirect` entrypoint, as in lipelix/zmrdly), keeping path and query. Applying `infra/`
  therefore also needs *Zone · Single Redirect · Edit* on its token.
- **Its own CSP in `site/_headers`.** The page loads Google Fonts (`style-src` fonts.googleapis.com, `font-src`
  fonts.gstatic.com) and runs one inline script that sets the theme before first paint. That script is allowed by
  its SHA-256 hash, not `'unsafe-inline'`, and `test/site.test.ts` fails when the script changes without the hash.
  The `pages.dev` hosts send `X-Robots-Tag: noindex`, so only agedrop.dev is indexed.
- **The page links to `https://app.agedrop.dev`** (the web UI item and the footer). Both go live with the same
  `tofu apply`.

## 2026-11-14 — Recipient type from the bech32 prefix, not a string prefix

**Context.** `isAgeRecipient` rejected anything starting with `age1tag` to keep tag recipients out. About one in
32768 random X25519 keys has data starting with `tag` (`age1tag…`), so a valid key was refused as "not a valid age
recipient". A throwaway key in a test broke CI that way once.

**Decision.**
- **The recipient type is the bech32 human-readable part**, everything before the last `1`, and only `age`
  (X25519) and `age1pq` (post-quantum) are allowed. The data charset has no `1`, so the split is exact. It keeps
  out `age1tag1…` and `age1tagpq1…` (both of which typage accepts, so the check has to stay ours) and plugin
  recipients, and a new recipient type typage learns later stays out until `SPEC.md` allows it.
- **Tests build valid tag recipients** (`throwawayTagRecipients` in `test/helpers.ts`, with `@scure/base`, which
  typage itself uses for bech32) and assert typage accepts them, so the rejection is shown to be ours.


## 2026-11-14 — The Cloudflare side is applied once from a laptop, by a script

**Context.** `infra/` (both Pages projects, the domains and DNS, the www redirect, and the repository's
deploy secret and variable) needs two Cloudflare API tokens, which only the dashboard can create, and a
Terraform Cloud login, which needs a browser. A headless server has neither, so the deploys stopped at
`Missing required secret: CLOUDFLARE_API_TOKEN`.

**Decision.** The owner runs `infra/bootstrap.sh` in an interactive session on a laptop. It does
everything else itself:
- runs `tofu login` and creates the `lipelix/agedrop` workspace with local execution;
- takes the GitHub token from `gh auth token`, so there is no PAT to create;
- asks for the two Cloudflare tokens with hidden input, checks them against the API (zone, account, Pages),
  and asks the owner to confirm the account is the personal one;
- shows `tofu plan` and applies only after a "y" (deletions need "apply anyway");
- runs both deploy workflows, then checks app.agedrop.dev (and its CSP), agedrop.dev and the www redirect.

Tokens go to tofu as `TF_VAR_*` environment variables and are never written to disk; the plan file, which holds
them, lives in a temporary directory that the script removes. `--check` does all of this read-only and stops
before applying.

## 2026-11-15 — Owner passkey checked on a real iPhone: PRF works, no passphrase wrapping

**Context.** The owner passkey flow had only run against a fake PRF authenticator and Chromium's virtual
authenticator. The open question from the 2026-11-14 owner passkey entry was whether Safari on a real iPhone
derives PRF keys from an iCloud Keychain passkey, and if not, whether to add passphrase (scrypt) wrapping.

**Check.** iPhone, iOS 27.0.1 (24A446), Safari, passkey in iCloud Keychain, against the deployed
`app.agedrop.dev` and a throwaway private repository with one secret encrypted to a file-based owner key.
- Sign-in with a fine-grained token, then **Owner → Set up a passkey** for a new owner: create the passkey and
  lock the key, one Face ID each. The backup was shown once, and the commit added `recipients/<name>.pub` and
  `recipients/<name>.identity.age` (an `age-encryption.org/fido2prf` stanza).
- On a laptop, the new owner was added to `owners` and `agedrop rekey` ran with the file-based owner key.
- **Lock**, then **Show**: one Face ID, and the value appeared, byte for byte the one that was added.
- `age -d -i backup.txt secrets/<scope>/<NAME>.age` with the stock `age` CLI gave the same value.

**Decision.** PRF works with iCloud Keychain passkeys on the iPhone, so **no passphrase (scrypt) wrapping**. The
backup stays the fallback for browsers or password managers without PRF.

**Found on the way** (separate issues): Safari offers to save the sign-in token as a password with no username,
and a repository without `agedrop.toml` also shows "defines no scopes yet".

## 2026-11-15 — A saved sign-in token is named after its repository

**Context.** On the iPhone check, Safari on iOS and macOS offered **Save password** after sign-in. The token
field had `autocomplete="off"`, which Safari ignores for password fields, and the form had no username field,
so the Keychain entry got an empty username or whatever Safari suggested (an email address). The next
sign-in offered that entry for the token field, whichever repository was typed.

**Options.** Prevent saving (a text field with masking, so Safari does not see a password), or keep saving and
label the entry.

**Decision.** Keep saving, labelled. The repository field gets `autocomplete="username"` and the token field
`autocomplete="current-password"`. The entry is then named `owner/name`, one per repository, and filling it
fills both fields, so it signs in to the repository the token was made for. The repository field already
holds the right value, so there is no hidden username field. Preventing saving would fight the browser
(masked text fields are fragile, and Safari's heuristics change), push users to paste tokens from notes, and
lose the Keychain's own protection. Saving stays the user's choice in the browser's prompt; a fine-grained
token is scoped to one repository and expires, and the page still keeps it only in `sessionStorage` unless
"Remember on this device" is ticked.

## 2026-11-15 — A repository without agedrop.toml is "not set up", said once

**Context.** Signed in to a repository without `agedrop.toml`, the inventory listed the problem
`agedrop.toml: missing` and, under it, "agedrop.toml defines no scopes yet.", which is wrong when there is no file.

**Decision.** The snapshot keeps `agedrop.toml: missing` in its problems, as `agedrop check` reports it, so writes
stay blocked for the same reason, and gains `configMissing`. The pages show that case once, as a notice that names
the repository and branch and says to run `agedrop init --owner <name>` there, and drop both the problem line and
the "no scopes" line. A wrong repository or branch looks the same as one not set up yet, so the notice names both.

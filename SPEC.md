# agedrop format — draft v0

Status: **draft**. The format library in `src/` implements the layout, `agedrop.toml`, recipients,
secret files, owner identity files, `agedrop.lock` and requests as written here, the CLI in `src/cli/` implements every
command in § Operations and § Notifications, and `web/` implements § Web UI. Breaking changes are expected until v1.

agedrop keeps secrets as [age](https://age-encryption.org) files in a git repository.
Git is the only storage. There is no agedrop server and no database.
Anyone with the public keys can **add** a secret. Only holders of a private key can **read** one.

## Goals

1. **No backend.** Storage is a git repo. History, backup and change audit come from git.
2. **Write with public keys only.** You can add or replace a secret (CLI, static web page, CI) without any private key.
3. **Agents ask, humans answer.** An AI agent or a script files a *request* for a secret it needs.
   A human fulfils it, and the value is encrypted straight to the machines that will use it.
   The requester never receives the value.
4. **Open format, no lock-in.** Every secret decrypts with the stock `age` CLI, with or without agedrop installed.

## Non-goals

- Protecting a secret from processes that run as the same OS user on a machine that holds its identity.
- Read audit for decryption. git can only show who *changed* a secret, not who read it.
- Dynamic or short-lived credentials.

## Repository layout

```
agedrop.toml                    # format version, scopes, recipient groups
recipients/
  <name>.pub                    # one age recipient (age1…) per file, plus metadata
  <name>.identity.age           # optional: an owner identity wrapped by a passkey
secrets/
  <scope>/<NAME>.age            # one secret per file, ASCII-armored age
agedrop.lock                    # per secret: recipient-set fingerprint (detects stale encryption), and each set's keys
requests/
  <id>.toml                     # open requests; removed when fulfilled
```

- `<scope>` is a deployment target, e.g. `mini/hq` or `ci/deploy`. It is a path and may nest:
  one or more segments joined by `/`, each matching `[a-z0-9][a-z0-9._-]*`.
  Scopes may nest (`mini` and `mini/hq` can both exist): a secret's scope is its file's directory under `secrets/`.
- `<NAME>` matches `[A-Z][A-Z0-9_]*` for env-style values. A lowercase name matching `[a-z][a-z0-9._-]*`,
  such as `github_app_key` or `tls.crt`, means a file-style value. Mixed case is invalid.
- Recipient names (`<name>` in `recipients/`) and group names match `[a-z0-9][a-z0-9_-]*`.
- Secret files are armored (`-----BEGIN AGE ENCRYPTED FILE-----`), so git diffs and the web UI handle them as text.
  The plaintext is the value's exact bytes: nothing is added or stripped, including a trailing newline.

## `agedrop.toml`

```toml
version = 0

[recipients]                    # groups of recipient names from recipients/
owners = ["libor"]              # can read every scope
mini   = ["server"]
ci     = ["github-actions"]

[scopes."mini/hq"]
recipients = ["owners", "mini"]

[scopes."ci/deploy"]
recipients = ["owners", "ci"]
```

Every secret in a scope is encrypted to the union of its groups. `owners` must be in every scope,
so a human can always rekey.

Validation rules:

- `version` is the integer `0`.
- `[recipients]` maps each group name to a non-empty list of distinct recipient names.
  The `owners` group must exist. Every listed name needs a `recipients/<name>.pub` file.
- `[scopes."<scope>"]` has exactly one key, `recipients`: a non-empty list of distinct group names
  that are defined in `[recipients]` and include `owners`.
- Unknown keys anywhere are an error, so a typo cannot silently drop a recipient.
- A scope's **recipient set** is the union of the age recipients of all members of its groups.
  Two names with the same age recipient count once.

## Recipients

`recipients/<name>.pub`:

```
# kind: machine | ci | owner
# added: 2026-11-09
age1…
```

| Kind | Private key lives | Notes |
|---|---|---|
| `machine` | on the host (`~/.config/agedrop/identity`, mode 600) | one per machine, not per service |
| `ci` | a CI secret (`AGEDROP_IDENTITY`) | |
| `owner` | the owner's devices, wrapped by a passkey in `<name>.identity.age`, plus an offline backup | lets the web UI decrypt in the browser after Face ID / Touch ID, via WebAuthn PRF |

Parsing rules:

- Lines starting with `#` are comments. A comment of the form `# <key>: <value>` is metadata.
  `kind` is required and is one of the kinds above. `added`, when present, is a date `YYYY-MM-DD`.
  Other metadata keys are kept and ignored. A key may appear only once.
- Exactly one other non-blank line holds the age recipient: an X25519 `age1…` key or a hybrid
  post-quantum `age1pq1…` key. Leading and trailing whitespace on a line is ignored.
  The type is the bech32 human-readable part, everything before the last `1`: `age` for X25519 and
  `age1pq` for post-quantum. Tag (`age1tag1…`, `age1tagpq1…`) and plugin (`age1<name>1…`) recipients
  are not allowed. The bech32 data has no `1`, so an X25519 key whose data starts with `tag`
  (`age1tag…` without a `1` after it) is an X25519 key.

### Owner identity files

`recipients/<name>.identity.age` holds an owner's private key wrapped by a passkey, so the web UI can
read secrets after Face ID or Touch ID without any private key on a server:

- It is an ASCII-armored age file. Its plaintext is an age identity file in `age-keygen` format:
  `# created: <RFC 3339 date-time>`, `# public key: <age1…>`, and one X25519 `AGE-SECRET-KEY-1…` line.
- Its only recipient is a passkey, through the WebAuthn PRF extension: one `age-encryption.org/fido2prf`
  stanza, as typage's `WebAuthnRecipient` writes it. The relying party is the web UI's host name
  (`app.agedrop.dev`). This file is the one file in the repository the stock `age` CLI does not
  decrypt by itself; the secrets it unlocks still do, with the offline backup (see below).
- `recipients/<name>.pub` must exist with `kind: owner`, and the identity's public key must equal its
  recipient. Readers check this after unwrapping and refuse an identity that does not match.
- **Offline backup.** When the web UI generates an owner identity, it shows the identity file once, to
  store on paper or in a password manager, and commits nothing until the owner confirms it is stored. The
  backup decrypts every secret the owner can read with `age -d -i <backup>`, and in the web UI it unlocks
  the page and wraps the identity for a new passkey. `docs/owner-passkey.md` is the recovery guide.

## `agedrop.lock`

`agedrop.lock` records the recipient set each secret file was encrypted to, because an age header
does not name its recipients:

```toml
version = 0

[secrets]
"mini/hq/VAPID_PRIVATE_KEY" = "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"

[sets."sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"]
libor = "age1…"
server = "age1…"
```

- Keys in `[secrets]` are secret paths under `secrets/` without `.age` (`<scope>/<NAME>`); writers sort them.
- `[sets]` maps every fingerprint used in `[secrets]` to the recipients it was computed from, as
  recipient name → age recipient. The fingerprint of the values must equal the table's key. Writers keep
  only the sets `[secrets]` uses. This is how `rekey` knows which keys could read a file before, so it can
  list the secrets to rotate after a key is removed or replaced, even when its `.pub` file is gone.
- The **recipient-set fingerprint** is `sha256:` followed by the lowercase hex SHA-256 of the scope's
  age recipient strings, deduplicated, sorted by byte value, each followed by `\n`.
  Names do not count, only keys: renaming a recipient keeps the fingerprint, replacing its key changes it.
- A secret is **stale** when its lock entry is missing or differs from its scope's current fingerprint.

## Requests

`requests/<id>.toml`. `<id>` is a short random id (`agedrop request` uses 8 characters from
`a-z` and `2-9` without `l`, `o`, `0` and `1`):

```toml
scope     = "mini/hq"
name      = "VAPID_PRIVATE_KEY"
reason    = "Web Push signing key for plan #50"
requested_by = "hq plan session #52"
created   = "2026-11-09T10:00:00Z"
# optional hints for the UI:
generate  = "openssl ecparam -genkey -name prime256v1 -noout"
```

A request holds no secret material and is safe to write from an agent.
To fulfil it, write `secrets/<scope>/<NAME>.age` and delete the request file in the same commit.
A request for a secret that already exists asks for a new value (rotation).

Validation rules:

- `<id>` matches `[a-z0-9][a-z0-9_-]*`.
- `scope` is a valid scope, `name` a valid secret name. `reason` and `requested_by` are non-empty strings.
- `created` is an RFC 3339 date-time with a time zone, as a TOML date-time or a string.
- `generate`, when present, is a string. Unknown keys are an error.

## Operations (CLI)

| Command | Needs a private key | What it does |
|---|---|---|
| `agedrop init --owner <name> [--ci github]` | no | creates `agedrop.toml` and an empty `agedrop.lock` in the current directory, and the notification workflow |
| `agedrop keygen <name> [--kind …]` | no | creates an identity on this host and its `recipients/<name>.pub` |
| `agedrop add <scope> <NAME>` | no | reads the value from stdin, encrypts it to the scope's recipients |
| `agedrop request <scope> <NAME> --reason …` | no | files a request |
| `agedrop requests [scope]` | no | lists open requests |
| `agedrop fulfil <id>` | no | prompts for the value, encrypts it, closes the request in one commit |
| `agedrop notify [id…] [--since <rev>]` | no | tells a human about new requests: ntfy, a webhook or Web Push |
| `agedrop ls [scope]` | no | lists secrets, last change (git), stale encryption, open requests |
| `agedrop pull <scope> --to <dir> \| --env <file>` | yes (host) | decrypts to files or to an env file |
| `agedrop exec <scope> -- <cmd>` | yes (host) | runs `<cmd>` with the scope's values in its environment |
| `agedrop rekey [scope]` | yes (owner) | re-encrypts to the current recipients and updates `agedrop.lock` |
| `agedrop check` | no | validates layout, names and lock fingerprints |

Common rules:

- The repository is the nearest directory, from the current one upwards, that holds `agedrop.toml`.
  `--repo <dir>` overrides the search.
- No command prints a secret value unless asked to with `-` as the destination (`pull --to -`, `pull --env -`,
  `keygen --out -`). Values are never read from arguments.
- Files holding values or identities are written with mode `600`, through a temporary file in the same
  directory and a rename, so a reader never sees a partial file. Directories the CLI creates for them get mode `700`.
- Problems are reported as `agedrop: <file>: <problem>`, one per line, and the exit code is `1`.
  Usage errors exit with `2`.

### Identity

Commands that decrypt use, in this order:

1. `--identity <file>`: an age identity file;
2. the `AGEDROP_IDENTITY` environment variable, holding the identity itself (one `AGE-SECRET-KEY-1…` per line), for CI;
3. `~/.config/agedrop/identity`.

When none is present the command fails and says how to create one. Identity files are in `age-keygen`
format, so `age -d -i ~/.config/agedrop/identity` reads every secret the host can read.

### `init`

Creates `agedrop.toml` with `version = 0` and `owners = ["<name>"]`, and an empty `agedrop.lock`.
It refuses to run where `agedrop.toml` already exists. The owner's public key is added with `keygen`
or by writing `recipients/<name>.pub` by hand.

`--ci github` also writes `.github/workflows/agedrop-requests.yml` (see § Notifications). In a repository that
already has `agedrop.toml`, `init --ci github` writes only the workflow, and `--owner` is not needed. It never
overwrites a workflow file.

### `keygen <name>`

Generates an X25519 identity and writes it to `--out <file>`, or to `~/.config/agedrop/identity` by default.
It never overwrites an identity file. `--out -` prints the identity instead, e.g. to store it as a CI secret.
`--kind` is `machine` (default), `ci` or `owner`. Inside a repository it writes `recipients/<name>.pub`
(and refuses to overwrite one); outside, it prints that file's contents. Adding the name to a group in
`agedrop.toml` is left to the owner.

### `add <scope> <NAME>`

Reads the value from stdin as exact bytes. From a terminal it reads one line without echo.
An empty value is an error. It writes `secrets/<scope>/<NAME>.age` encrypted to the scope's recipient set
and records the set's fingerprint in `agedrop.lock`.

### `ls [scope]`

Lists every secret (or those in `scope` and the scopes nested in it) with its last commit date and author
from `git log`, `uncommitted` when it has changes git does not have yet, and its status: `ok`, `stale`
(see `agedrop.lock`) or `unknown scope`. Then it lists open requests. `--json` prints the same as JSON.

### `check`

Exits `0` when the repository follows this spec and `1` otherwise, listing every problem:

- `agedrop.toml`, every `recipients/*.pub` and every `requests/*.toml` parse and validate;
- every file under `secrets/` is `secrets/<scope>/<NAME>.age` for a scope defined in `agedrop.toml`
  and is an ASCII-armored age file;
- every secret has an `agedrop.lock` entry equal to its scope's current fingerprint, and every lock entry has a secret file;
- every fingerprint in `[secrets]` has a `[sets]` entry, and every `[sets]` entry's keys hash to its fingerprint;
- every request names a defined scope;
- every `recipients/<name>.identity.age` is an ASCII-armored age file and has a `recipients/<name>.pub`
  of kind `owner`.

`check` never decrypts, so it runs in CI without an identity.

### `pull <scope> [NAME…]`

Decrypts the secrets directly in `secrets/<scope>/` (not nested scopes), or only the named ones:

- `--to <dir>` writes each value to `<dir>/<NAME>` as exact bytes. `--to -` prints one value to stdout,
  so it needs exactly one secret.
- `--env <file>` writes the env-style values as `NAME=value` lines; `--env -` prints them. File-style
  values are skipped with a note. A value is written bare when it only holds `A-Z a-z 0-9 _ . , / : @ + = -`,
  in single quotes when it holds no `'`, and otherwise in double quotes with `\`, `"`, `$` and newlines
  escaped as `\\`, `\"`, `\$` and `\n`. An env-style value must be valid UTF-8 without NUL bytes.

### `request <scope> <NAME> --reason <text>`

Writes `requests/<id>.toml` for a defined scope and a valid name, and prints `<id>` on stdout.
`--by <who>` sets `requested_by`; without it, `AGEDROP_REQUESTED_BY`, else `<user>@<host>`.
`--generate <cmd>` adds the `generate` hint. When a request for the same scope and name is already open,
it prints that request's id and writes nothing, so a retried agent does not file duplicates.
It reads no stdin, takes no value and needs no key, so it is safe to run from an agent.
It does not commit: the requester commits and pushes the file.

### `requests [scope]`

Lists the open requests (in `scope` and the scopes nested in it, or all): id, secret, created, requester
and reason. `--json` prints them as JSON, with the `generate` hint. `ls` lists them too.

### `fulfil <id>`

Shows the request and reads the value like `add`: from stdin, or from a terminal one hidden line.
When the request has a `generate` hint, from a terminal it shows the command and asks whether to run it;
`--generate` runs it without asking. The command runs with `sh -c` in the current directory; its stdout is the value
and its stderr is passed through. For an env-style name, trailing newlines are removed, as shell `$(…)` does;
a file-style value keeps the exact bytes. A failing command or an empty value writes nothing.
Then it writes `secrets/<scope>/<NAME>.age` and `agedrop.lock` as `add` does, deletes the request file,
and commits exactly those paths (other staged changes stay staged) with the message
`chore(secrets): fulfil <scope>/<NAME> (request <id>)`. `--no-commit`, or a repository outside a git work
tree, skips the commit. It never prints the value, and it does not push.

### `notify [id…]`

Sends one notification per request to every configured target (see § Notifications). Which requests:

- the `<id>`s given;
- with `--since <rev>`, the request files that exist at `HEAD` and not at `<rev>` (`git diff --diff-filter=A`).
  A `<rev>` of all zeros, as GitHub's `github.event.before` is for a new branch, means every open request;
- otherwise every open request.

A request file that does not validate is reported and skipped. `--dry-run` prints each notification's JSON
payload on stdout and sends nothing, and needs no target. Without `--dry-run` and with no target configured, the
command fails before reading any request. A failed delivery is reported as `agedrop: <target>: <problem>`
without the target's URL (it may hold a token), the other deliveries still run, and the exit code is `1`.

### `rekey [scope]`

Re-encrypts the stale secrets (in `scope` and the scopes nested in it, or all) to their scope's current
recipient set and updates `agedrop.lock`. `--all` re-encrypts every secret, stale or not.
It needs an owner identity (see § Identity): one of its keys must belong to a member of the `owners` group,
and with nothing to re-encrypt it needs none. A secret that cannot be decrypted is reported and skipped,
and the command exits `1` after doing the rest.

A secret must be **rotated** when a key that could read it is not in its new recipient set: old commits
stay decryptable by that key. `rekey` compares the `[sets]` entry of each secret's old fingerprint with
the new set and prints, on stdout, one line per such secret with the names of the keys removed or replaced:

```
rotate mini/hq/VAPID_PRIVATE_KEY: no longer for laptop (age1…)
```

A secret whose previous recipients are unknown (no lock entry or no `[sets]` entry) is listed for rotation too.
`rekey` does not commit; review the diff and commit it.

### `exec <scope> -- <cmd> [args…]`

Decrypts the env-style secrets directly in `secrets/<scope>/`, runs `<cmd>` with them added to the current
environment (they win over variables of the same name), and exits with its exit code. Nothing is written to disk.
File-style secrets are skipped with a note.

## Notifications

A human learns about a new request without a backend: a CI job runs `agedrop notify` when a push adds a request.

### Workflow

`agedrop init --ci github` writes `.github/workflows/agedrop-requests.yml`. It runs on a push that touches
`requests/**`, only on the default branch, checks the repository out with its history, and runs
`npx --yes agedrop@<version> notify --since <github.event.before>`, where `<version>` is the version of the CLI
that wrote it. The targets come from repository secrets of the same names as the variables below. It needs
`contents: read` and nothing else.

### Content

A notification says which secret is requested and links to the request's fulfil form. It never holds a value
and never the `generate` hint. Its fields:

| Field | Value |
|---|---|
| `type` | `agedrop.request` |
| `repository` | `owner/name`, from `--github <owner/name>` or `GITHUB_REPOSITORY`; absent when neither is set |
| `request` | `id`, `scope`, `name`, `reason`, `requested_by` and `created` of the request file; `reason` is cut to 500 characters |
| `rotation` | `true` when `secrets/<scope>/<NAME>.age` already exists, so the request asks for a new value |
| `url` | the fulfil form: `<app>/#/requests/<id>?repo=<owner/name>`, `<app>` being `https://app.agedrop.dev` or `--app-url`; absent without a repository |

The title is `Secret requested: <scope>/<NAME>`, or `New value requested: <scope>/<NAME>` for a rotation.
The message is the reason, then `by <requested_by>` on its own line. A request is untrusted input (see
§ Security notes): the notification shows the requester's claim, and the human decides in the fulfil form.

### Targets

A target is configured when its variable is set and not empty (GitHub passes an unset secret as an empty string).

| Target | Variables | Request |
|---|---|---|
| [ntfy](https://ntfy.sh) | `AGEDROP_NTFY_URL`: the topic URL, e.g. `https://ntfy.sh/<topic>`. `AGEDROP_NTFY_TOKEN`, optional: an access token | `POST` of ntfy's JSON message (`topic`, `title`, `message`, `click` = `url`, `tags` = `["key"]`) to the server, the topic URL without its last path segment; the token as `Authorization: Bearer` |
| Webhook | `AGEDROP_WEBHOOK_URL`: an `https` or `http` URL. `AGEDROP_WEBHOOK_SECRET`, optional | `POST` of the JSON payload (the fields above plus `title` and `message`), `Content-Type: application/json`. With a secret, `X-Agedrop-Signature: sha256=<hex HMAC-SHA256 of the body>` |
| Web Push | `AGEDROP_WEBPUSH_SUBSCRIPTIONS`: a `PushSubscription` as JSON (`endpoint`, `keys.p256dh`, `keys.auth`) or an array of them. `AGEDROP_VAPID_PRIVATE_KEY`: the VAPID P-256 private key, base64url of its 32 bytes, as `web-push generate-vapid-keys` prints it. `AGEDROP_VAPID_SUBJECT`: a `mailto:` or `https:` contact for the push service | the JSON payload of the webhook, encrypted per subscription with RFC 8291 (`Content-Encoding: aes128gcm`), with a VAPID (RFC 8292) `Authorization: vapid t=<JWT>, k=<public key>` header, `TTL: 86400` and `Urgency: high` |

Web Push needs all three of its variables: setting some of them is an error. A push service that answers `404`
or `410` has dropped the subscription; it is reported like any failed delivery. `docs/notifications.md` has a
recipe for each target.

## Web UI

A static page at `https://app.agedrop.dev/` (built from `web/`) adds secrets and fulfils requests from any
browser, a phone included. It has no backend: it reads and writes the repository through the GitHub API,
encrypts in the browser with the same format library as the CLI, and needs no private key. An owner can
also read values there, after unlocking an identity wrapped by a passkey (see § Owner passkey).

### Sign-in

The page asks for the repository (`owner/name`), an optional branch (default: the repository's default
branch) and a GitHub **fine-grained personal access token** that covers that repository with
*Contents: read and write* (GitHub adds *Metadata: read*). The page reads the repository with the token
before it stores anything, so a token GitHub refuses, or one that does not cover the repository, is never
kept. The token is kept in `sessionStorage`, or in `localStorage` when "Remember on this device" is
ticked, and is sent only to `https://api.github.com`. There is no OAuth: GitHub's token exchange needs a
client secret and a server.

A device can be signed in to several repositories. The name of the open repository in the top bar leads
to **Repositories**, which lists them, opens one with a tap, removes one, and adds the next with the same
form. Every page shows one repository at a time, the open one; a tab keeps its own, so two tabs can work
in two repositories. One fine-grained token can cover several repositories of an owner, so the form offers
the token of a signed-in repository, of the same owner first, instead of asking for a new one. Each
repository has its own branch and its own "Remember" choice. Changing repository locks an unlocked owner
key and hides shown values. "Remove" forgets one repository on this device and "Sign out" forgets all of
them; neither revokes the token on GitHub. When GitHub rejects a token, every repository signed in with
it is removed and the page says which.

Password managers may save the token, and the form tells them what it is: the repository field has
`autocomplete="username"` and the token field `autocomplete="current-password"`. A saved entry (Safari's
Keychain, for one) is then named after the repository, and filling it fills both the repository and its
token. The branch field has `autocomplete="off"`. Whether to save stays the user's choice in the browser's
prompt; the page neither asks for it nor prevents it.

### Pages

- **Inventory**: every scope in `agedrop.toml` with its recipients, and its secrets with kind, last change
  (date and author of the last commit that touched the file) and status `ok`, `stale` or `unknown scope`
  as `ls` computes it. Open requests are counted and linked. Problems found by the checks `check` runs on
  `agedrop.toml`, `recipients/*.pub`, `agedrop.lock` and `requests/*.toml` are listed. A branch without
  `agedrop.toml` is not set up: the page says so once, names the repository and branch, and tells to run
  `agedrop init --owner <name>` there, instead of listing `agedrop.toml: missing` or saying it has no scopes.
- **Add or replace**: a scope defined in `agedrop.toml`, a secret name and its value.
- **Requests**: the open requests, newest first. Each opens a fulfil form that shows its scope, name,
  reason, requester, date and `generate` hint. The hint is shown as text and never run. A notification links to
  `#/requests/<id>?repo=<owner/name>`: signed out, the sign-in form fills in that repository and opens the form
  after sign-in; signed in to that repository but with another one open, the page opens it and says so;
  not signed in to it, the page says so instead of showing a missing request and offers to add it, and
  opens the form once it is added.
- **Owner**: set up an owner passkey, unlock with it or with the backup, and lock (see § Owner passkey).
  The inventory has a **Show** button on each secret.

### Values

- An env-style value is one line of text. A file-style value is multi-line text, with `\n` line endings,
  or the exact bytes of a file picked from the device. The value is stored exactly as entered.
- "Generate" fills in 32 random bytes from `crypto.getRandomValues`, base64url-encoded without padding.
- A value is masked until "Show" is ticked: the field is an ordinary text field drawn in a font whose every
  character is the same dot, not a password field and not `-webkit-text-security`, which Safari's AutoFill
  takes for one. Password managers then neither offer a saved sign-in for the form's fields nor offer to
  save the value. The font is inlined in the stylesheet, and the Content Security Policy allows `data:` fonts.
- An empty value, an env-style value with a NUL byte and a file over 1 MiB are refused.
- The value lives only in the form and in memory while it is encrypted. It is never put in storage, a URL
  or a log, and only its age ciphertext leaves the device. The form is cleared after the commit.

### Writes

Every action is one commit, made with the GraphQL `createCommitOnBranch` mutation:

| Action | Files | Message |
|---|---|---|
| add | `secrets/<scope>/<NAME>.age`, `agedrop.lock` | `chore(secrets): add <scope>/<NAME>` |
| replace | the same | `chore(secrets): replace <scope>/<NAME>` |
| fulfil | the same, and `requests/<id>.toml` deleted | `chore(secrets): fulfil <scope>/<NAME> (request <id>)` |

The secret is encrypted to the scope's current recipient set and recorded in `agedrop.lock` as `add` does.
The commit names the head the page loaded as `expectedHeadOid`, so a push in between makes it fail instead
of overwriting. The page then reloads the repository, encrypts again to the recipients it now finds, and
tries once more. It refuses to write when `agedrop.toml`, the scope's recipients or `agedrop.lock` do not
validate, or when the request it fulfils is gone.

### Owner passkey

The **Owner** page sets up a passkey for an owner and unlocks the page with it. Passkeys exist only in
browsers, so this is the one step without a CLI command.

- **Set up** takes an owner name. When `recipients/<name>.pub` does not exist, the page generates an X25519
  identity; when it exists with `kind: owner`, the owner pastes that identity (from its backup or
  `~/.config/agedrop/identity`) and the page checks that its public key matches. Then, each step on its
  own tap: it creates a passkey (`agedrop <name> (<owner/repo>)`) with the PRF extension, wraps the identity
  with it, and, for a generated identity, shows the backup and waits for the owner to confirm it is stored.
  It commits one commit:

  | Case | Files | Message |
  |---|---|---|
  | new owner | `recipients/<name>.pub` (`kind: owner`, `added` today), `recipients/<name>.identity.age` | `chore(recipients): add owner <name> with a passkey` |
  | existing owner | `recipients/<name>.identity.age` | `chore(recipients): set the passkey of owner <name>` |

  A new owner reads secrets once the name is in the `owners` group of `agedrop.toml` and `rekey` has run;
  `agedrop init --owner <name>` puts it there from the start. Setting up again replaces the passkey: the old
  one stops working.
- **Unlock** asks for the passkey and unwraps the owner's identity file. When several owners have one, the
  page asks which. **Unlock with the backup** takes the pasted identity instead, for a lost passkey or a
  browser without PRF. The identity lives only in the page's memory, never in storage, a URL or a log,
  and is dropped after 5 minutes, on "Lock", and on sign-out.
- **Show** on a secret in the inventory unlocks first when needed, then decrypts the secret in the browser
  and shows its value. Values are hidden until asked for, and hidden again after 30 seconds, when the tab is
  hidden, and when the page changes. A value that is not UTF-8 text is shown as its size, with a download.
  "Copy" puts it on the clipboard.

## Security notes

- **Plaintext never enters the repo.** The CLI and the web UI encrypt locally, and nothing else ever handles a value.
- **Write integrity.** Anyone who can push can *replace* a secret, though they cannot read one.
  Use branch protection or PRs for `secrets/`, and signed commits. `ls` shows who changed each secret last.
- **Removing a recipient does not revoke history.** Old commits stay decryptable by the removed key.
  `rekey` after removal prints the list of secrets to rotate.
- **Requests are untrusted input.** Anyone who can push can file a request, including an agent. Its `reason`
  is only a claim, and its `generate` hint is a shell command written by the requester: `fulfil` shows it
  and runs it only after the human confirms (or passes `--generate`). Read it before saying yes.
- **Agents never hold an identity.** A requester learns that a secret exists, never its value. A host that
  needs the value runs `pull` or `exec` with its own identity, outside the agent's session.
- **The web UI's token can push.** Anyone holding it can replace secrets and file requests, though not read
  a value. Give it only the one repository and *Contents*, and an expiry. The page loads no third-party code,
  and its Content Security Policy lets it connect only to `api.github.com`.
- **Owner identity files are only as safe as the passkey and the backup.** The wrapped identity is public
  in the repository; unwrapping it needs the passkey and the owner's Face ID, Touch ID or device PIN. The
  backup is the identity in plaintext: keep it offline. A passkey that is lost or deleted cannot be
  recovered, so the backup is the only way back. Someone who can push could replace `<name>.pub` and
  `<name>.identity.age` with their own; the page refuses an identity that does not match `<name>.pub`, but
  `<name>.pub` changes need the same review as `secrets/`.
- **Decrypting in the browser** puts the value in the page's memory and on screen. The page shows it only on
  request, hides it again, and never stores or sends it.
- **Lock fingerprints.** age headers do not reveal recipients, so `agedrop.lock` records a hash of the
  recipient set used for each file. This lets `check` flag files that need `rekey` without decrypting them.

## Open questions

1. ~~**Implementation language.**~~ Decided 2026-11-14: TypeScript with `age-encryption` (typage) for both the
   CLI and the web UI, with compatibility tests against the Go `age` CLI. See `docs/decisions.md`.
2. ~~**Web UI auth on a static page.**~~ Decided 2026-11-14: a pasted fine-grained token kept in the browser,
   no token-exchange Worker. See § Web UI and `docs/decisions.md`.
3. ~~**Notifications for requests** without a backend.~~ Decided 2026-11-14: `agedrop notify`, run by a workflow that
   `init --ci github` writes, posts to ntfy, a webhook or Web Push. See § Notifications and `docs/decisions.md`.
4. **Armor vs binary** for large file-style values, such as certificates or keys over a few KB.

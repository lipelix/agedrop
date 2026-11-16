# agedrop

Secrets as [age](https://age-encryption.org) files in git. Anyone with the public keys can add a secret, only
holders of a private key can read one, and an AI agent can ask for a secret without ever seeing its value.

- **No backend.** The git repository is the only storage. History, backup and change audit come from git.
- **Writes need public keys only.** Add or replace a secret from a laptop, CI or a phone without any private key.
- **Agents ask, humans answer.** An agent commits a request. You fulfil it, and the value is encrypted straight to
  the machines that use it. The agent never receives it.
- **No lock-in.** Each secret is its own armored age file, and every file decrypts with the stock `age` CLI.

Status: **v0.1, format draft v0.** The format is in [SPEC.md](SPEC.md). Breaking changes are possible until v1.

## Quickstart

You need Node.js 22.12 or newer and git. Run it in a new git repository, or in the one you deploy from.

```sh
npx agedrop init --owner alice          # agedrop.toml and agedrop.lock
npx agedrop keygen alice --kind owner   # ~/.config/agedrop/identity and recipients/alice.pub
```

Add a scope (a deployment target) to `agedrop.toml`:

```toml
[scopes."laptop/app"]
recipients = ["owners"]
```

Then add, list and use secrets:

```sh
npx agedrop add laptop/app STRIPE_KEY          # reads the value without echo, writes secrets/laptop/app/STRIPE_KEY.age
npx agedrop ls                                 # every secret, its last change and whether it needs rekey
npx agedrop exec laptop/app -- npm start       # runs the command with the scope's values in its environment
npx agedrop pull laptop/app --env .env         # or writes them to an env file (mode 600)
git add . && git commit -m "chore(secrets): add STRIPE_KEY" && git push
```

Install it globally with `npm install -g agedrop` to drop the `npx`. Without agedrop, `age` reads the same file:

```sh
age -d -i ~/.config/agedrop/identity secrets/laptop/app/STRIPE_KEY.age
```

### Another machine

On a server, `agedrop keygen mini --kind machine` creates the server's identity and `recipients/mini.pub`. Add
`mini` to a group and the group to a scope in `agedrop.toml`, then run `agedrop rekey` where your owner identity
is, so the existing secrets are encrypted to the server too. Commit and push. The server can now
`agedrop exec <scope> -- <cmd>`.

For CI, `agedrop keygen github-actions --kind ci --out -` prints an identity: store it as the CI secret
`AGEDROP_IDENTITY` and do not keep a copy.

### Requests from an agent

```sh
agedrop request laptop/app DATABASE_URL --reason "Postgres for the app"   # no value, no key needed
git add requests && git commit -m "chore(secrets): request DATABASE_URL" && git push
```

You answer with `agedrop fulfil <id>` or in the web UI. `agedrop init --ci github` writes a workflow that notifies
you about new requests through ntfy, a webhook or Web Push. See [docs/agents.md](docs/agents.md) and
[docs/notifications.md](docs/notifications.md).

### Web UI

[app.agedrop.dev](https://app.agedrop.dev) is a static page: no agedrop server, and no third-party code. Paste a
fine-grained GitHub token scoped to your secrets repositories, then list secrets, add them and answer requests from a phone.
Reading a value in the browser uses an owner identity wrapped by a passkey ([docs/owner-passkey.md](docs/owner-passkey.md)).

## Commands

| Command                                    | Needs a private key | What it does                                                |
| ------------------------------------------ | ------------------- | ----------------------------------------------------------- |
| `init --owner <name> [--ci github]`        | no                  | creates `agedrop.toml`, `agedrop.lock` and the notify workflow |
| `keygen <name> [--kind …]`                 | no                  | creates an identity on this host and its `recipients/<name>.pub` |
| `add <scope> <NAME>`                       | no                  | encrypts a value from stdin to the scope's recipients       |
| `request <scope> <NAME> --reason …`        | no                  | files a request for a secret                                |
| `requests [scope]`                         | no                  | lists open requests                                         |
| `fulfil <id>`                              | no                  | encrypts the value and closes the request in one commit     |
| `notify [id…]`                             | no                  | tells a human about new requests                            |
| `ls [scope]`                               | no                  | lists secrets, last change, stale encryption, open requests |
| `check`                                    | no                  | validates layout, names and lock fingerprints (for CI)      |
| `pull <scope> --to <dir> \| --env <file>`  | yes (host)          | decrypts a scope to files or an env file                    |
| `exec <scope> -- <cmd>`                    | yes (host)          | runs a command with the scope's values in its environment   |
| `rekey [scope]`                            | yes (owner)         | re-encrypts stale secrets to the current recipients         |

`agedrop <command> --help` shows each command's options.

## Threat model in brief

- **Plaintext never enters the repository.** The CLI and the web UI encrypt locally.
- **A push can replace a secret, not read it.** Anyone with push access can overwrite a secret or a
  `recipients/*.pub` file. Protect `secrets/` and `recipients/` with branch protection or pull requests, and sign
  commits. `agedrop ls` shows who changed each secret last.
- **Removing a recipient does not revoke history.** Old commits stay readable with the removed key. Rotate the
  values that key could read; `rekey` lists them.
- **Requests are untrusted input.** A request's reason is a claim, and its `generate` hint is a command written by
  the requester. `fulfil` runs it only after you confirm.
- **Not in scope:** protecting a secret from processes that run as the same OS user on a machine that holds its
  identity, read audit, and dynamic or short-lived credentials.

The full list is in [SPEC.md § Security notes](SPEC.md#security-notes). To report a vulnerability, see
[SECURITY.md](SECURITY.md).

## Compared with

|                                     | agedrop                 | SOPS + age                | dotenvx                   | Phase / Infisical          |
| ----------------------------------- | ----------------------- | ------------------------- | ------------------------- | -------------------------- |
| Storage                             | age files in git        | encrypted files in git    | encrypted `.env` in git   | their server (cloud or self-hosted) |
| Add a value without a private key   | yes                     | no (needs the data key)   | yes                       | yes, with an account       |
| Read without the tool               | stock `age`             | needs `sops`              | needs `dotenvx`           | no                         |
| Private keys                        | one per recipient       | one per recipient         | one per environment, shared | on their server          |
| Remove a person or machine          | drop the recipient, `rekey` lists what to rotate | drop the recipient, `updatekeys`, rotate | new key pair for everyone, or their hosted Armor | in the server       |
| Binary values (keys, certificates)  | yes                     | yes                       | no (`.env` values)        | yes                        |
| Web UI                              | static page, no backend | no                        | hosted Armor (paid)       | yes, with a server         |
| Agent asks for a secret it lacks    | request, value never shown | no                     | no                        | via their server           |
| Agent runs with secrets             | `exec` (redaction planned) | `exec-env`             | `run --redact` masks output; approvals in Armor | via their server |
| Server to run or pay for            | none                    | none                      | none (Armor is optional)  | yes                        |

Phase and Infisical do more: access policies, read audit, dynamic secrets, integrations. Choose them when you need
those and can run or pay for a server. dotenvx is the closest relative and much further along: SDKs for several
languages, OS keychain storage, output redaction and a pre-commit guard; its hosted Armor adds approvals and read
audit. Why agedrop exists is in [docs/decisions.md](docs/decisions.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)

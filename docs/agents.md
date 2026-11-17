# Requesting secrets from an agent

This is for anyone writing an AI agent or an automated session (Claude Code, HQ plan sessions, CI bots) that
needs a secret it does not have. The agent asks for the secret, a human provides it, and the agent never
sees the value. Format details are in [SPEC.md](../SPEC.md) § Requests.

## Rules

- **Never read a value.** Do not run `agedrop pull … --to -`, `pull --env -`, `age -d`, or `cat` a decrypted
  file. Do not ask the human to paste a value into the chat.
- **Never hold an identity.** An agent session gets no `~/.config/agedrop/identity` and no `AGEDROP_IDENTITY`.
  The host that runs the service decrypts with its own identity, outside the agent's session.
- **Request, commit, push, wait.** A request is a plain file with no secret material, so it is safe to commit.

## Request a secret

```sh
id=$(agedrop request mini/hq VAPID_PRIVATE_KEY \
  --reason "Web Push signing key for plan #50" \
  --by "hq plan session #52" \
  --generate "openssl ecparam -genkey -name prime256v1 -noout")
git add "requests/$id.toml"
git commit -m "chore(secrets): request mini/hq/VAPID_PRIVATE_KEY"
git push
```

- `<scope>` must already exist in `agedrop.toml`. Run `agedrop ls` to see the scopes and secrets. Adding a
  scope or a recipient is the owner's job, so say so in your handoff if one is missing.
- `--reason` is what the human reads before deciding. Say what the value is for and where it will be used.
- `--generate` is optional. Give it when a command can make a suitable value (random tokens, key pairs). The
  human sees the command and decides whether to run it. Keep it to one well-known command, with no network
  access and no side effects.
- Running `request` again for the same secret prints the open request's id and writes nothing, so a retry is safe.
- A request for a secret that already exists asks for a new value (rotation).

## Wait for it

When the repository has the notification workflow (`agedrop init --ci github`, see
[notifications.md](notifications.md)), the push tells the human about the request; nothing else is needed.

The human runs `agedrop fulfil <id>`, which writes `secrets/<scope>/<NAME>.age` and deletes the request in one
commit. A request is done when its file is gone from the default branch:

```sh
git pull --ff-only
test -f "requests/$id.toml" || echo fulfilled
agedrop ls mini/hq            # VAPID_PRIVATE_KEY shows up with status ok
agedrop requests --json       # what is still open
```

Do not poll in a tight loop. If the session cannot wait, stop and hand off. For an HQ plan session that
means a `blocked` handoff whose question names the request:

> 1. Please fulfil request `k3x9abcd` (`mini/hq/VAPID_PRIVATE_KEY`): `agedrop fulfil k3x9abcd`, then push.

The next session continues once the request file is gone.

## Use it

The agent's code refers to the secret by name and lets the host decrypt it at start-up, for example:

```sh
agedrop exec mini/hq -- node server.js          # values only in the child's environment
agedrop pull mini/hq --env /run/hq/app.env      # or a mode 600 env file for docker compose
```

These run on the host, with the host's identity, as part of its deploy, not inside the agent's session.

## Do not commit what was decrypted

`pull` writes plaintext. Inside a git work tree it adds the files to `.gitignore`, and a repository protected with
`agedrop protect` refuses a commit that holds plaintext under `secrets/`, an age private key or an unignored `.env`
file. When the hook stops a commit, unstage the file it names (`git rm --cached <file>`); never commit with
`--no-verify` to get past it, and never `git add -f` a file `.gitignore` covers. The hook's messages name the file,
never the value.

## Run a command that has the values

The rules above keep identities out of an agent's session. When an agent's commands still run on a host that
holds one, for example a development machine where the agent starts the app or runs its tests through
`agedrop exec`, whatever those commands print lands in the transcript and its logs. Run them with `--redact`:

```sh
agedrop exec laptop/app --redact -- npm test
```

- Every value of 6 bytes or more becomes `[REDACTED:<NAME>]` in stdout and stderr, also its URL-encoded,
  JSON-escaped and base64 forms. The exit code is the command's.
- The owner sets `redact = true` on such a scope in `agedrop.toml`, so leaving out the flag shows nothing more;
  `--no-redact` is refused there.
- The command gets pipes, not a terminal, on stdout and stderr: interactive programs and progress bars may
  behave differently.
- It is hygiene, not isolation. The command has the values and can write them to a file or send them anywhere,
  and an agent on that host could run `age -d` itself. Treat `[REDACTED:…]` as final: do not print a value
  reversed, split or encoded some other way to see it.
- `agedrop ls` and `agedrop check` warn about values too short to redact. Tell the owner, who can rotate them to
  longer ones.

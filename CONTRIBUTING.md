# Contributing

Issues and pull requests are welcome. For a security problem, follow [SECURITY.md](SECURITY.md) instead.

## Ground rules

- [SPEC.md](SPEC.md) is the format. A change to the format or to a command's behaviour changes SPEC.md first, in
  the same pull request, and the two stay in sync.
- [docs/decisions.md](docs/decisions.md) records why things are the way they are. Append a dated entry for a new
  decision; do not rewrite old ones.
- Every secret file must decrypt with the stock `age` CLI. `test/age-cli.test.ts` guards this.
- Never commit plaintext secrets, real identities or private keys, including in tests. Tests generate throwaway
  keys.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org) in English, e.g.
  `fix(cli): keep the mode of an existing env file`.
- Code, docs and issues are in English.

## Set up

You need Node.js 22.12 or newer, git and the Go [`age`](https://github.com/FiloSottile/age) CLI (`age` and
`age-keygen` on `PATH`) for the compatibility tests.

```sh
npm ci
npm run lint        # eslint and prettier
npm run typecheck
npm test            # vitest: format library, CLI and age CLI compatibility
npm run build       # dist/, the npm package
npm run dev:web     # the web UI on a local Vite server
npm run test:web    # Playwright in WebKit and Chromium (npx playwright install webkit chromium first)
```

Run the CLI from a checkout with `npm run build && node dist/cli/main.js <command>`.

## Layout

| Path        | What                                                        |
| ----------- | ----------------------------------------------------------- |
| `src/`      | format library, exported as `agedrop` and `agedrop/node`   |
| `src/cli/`  | the `agedrop` command                                       |
| `web/`      | the static web UI (app.agedrop.dev)                         |
| `site/`     | the landing page (agedrop.dev)                              |
| `test/`     | unit, CLI and age compatibility tests                       |
| `e2e/`      | Playwright tests for the web UI                             |
| `infra/`    | OpenTofu for Cloudflare Pages, DNS and the GitHub settings  |

## Pull requests

CI runs lint, typecheck, the tests, both builds and the web UI tests on every pull request. Keep a pull request to
one change, and add a line under **Unreleased** in [CHANGELOG.md](CHANGELOG.md) when users would notice it.

## Releases

Maintainers release from `main`:

1. Move the **Unreleased** entries in `CHANGELOG.md` to a new `## [x.y.z] - YYYY-MM-DD` section and update the
   links at the bottom.
2. Set the version: `npm version x.y.z --no-git-tag-version`, then commit both files as
   `chore(release): x.y.z` and merge it.
3. Tag the merge commit with a signed tag and push it:

   ```sh
   git tag -s vx.y.z -m "agedrop x.y.z"
   git push origin vx.y.z
   ```

The [release workflow](.github/workflows/release.yml) checks that the tag is signed (GitHub must show it as
verified) and matches `package.json` and the changelog, runs the checks, publishes to npm with provenance, runs
`npx agedrop@x.y.z init` against the published package and creates the GitHub release.

npm needs either the repository secret `NPM_TOKEN` (a granular token that can publish `agedrop`) or a trusted
publisher on npmjs.com for this repository and `release.yml`. Trusted publishing is preferred once the package
exists; then delete the token.

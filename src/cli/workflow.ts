/** Where `agedrop init --ci github` writes the request notification workflow. */
export const GITHUB_WORKFLOW_PATH = ".github/workflows/agedrop-requests.yml";

/** The workflow that runs `agedrop notify` for new requests (SPEC.md § Notifications). */
export function githubWorkflow(version: string): string {
  return `# Written by agedrop init --ci github: tells a human about new requests for secrets.
# Set one or more of these repository secrets (Settings → Secrets and variables → Actions):
#   ntfy:     AGEDROP_NTFY_URL (https://ntfy.sh/<topic>), AGEDROP_NTFY_TOKEN (optional)
#   webhook:  AGEDROP_WEBHOOK_URL, AGEDROP_WEBHOOK_SECRET (optional)
#   Web Push: AGEDROP_WEBPUSH_SUBSCRIPTIONS, AGEDROP_VAPID_PRIVATE_KEY, AGEDROP_VAPID_SUBJECT
# Recipes: https://github.com/lipelix/agedrop/blob/main/docs/notifications.md
name: agedrop requests

on:
  push:
    paths: ["requests/**"]

permissions:
  contents: read

concurrency:
  group: agedrop-requests-\${{ github.ref }}

jobs:
  notify:
    if: github.ref == format('refs/heads/{0}', github.event.repository.default_branch)
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          persist-credentials: false

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Notify about new requests
        run: npx --yes agedrop@${version} notify --since "$BEFORE"
        env:
          BEFORE: \${{ github.event.before }}
          AGEDROP_NTFY_URL: \${{ secrets.AGEDROP_NTFY_URL }}
          AGEDROP_NTFY_TOKEN: \${{ secrets.AGEDROP_NTFY_TOKEN }}
          AGEDROP_WEBHOOK_URL: \${{ secrets.AGEDROP_WEBHOOK_URL }}
          AGEDROP_WEBHOOK_SECRET: \${{ secrets.AGEDROP_WEBHOOK_SECRET }}
          AGEDROP_WEBPUSH_SUBSCRIPTIONS: \${{ secrets.AGEDROP_WEBPUSH_SUBSCRIPTIONS }}
          AGEDROP_VAPID_PRIVATE_KEY: \${{ secrets.AGEDROP_VAPID_PRIVATE_KEY }}
          AGEDROP_VAPID_SUBJECT: \${{ secrets.AGEDROP_VAPID_SUBJECT }}
`;
}

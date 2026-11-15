# Notifications for requests

An agent files a request and pushes it. A CI job then tells you, with a link to the request's fulfil form.
There is no agedrop server: the job runs `agedrop notify` in your repository's CI. Format details are in
[SPEC.md](../SPEC.md) § Notifications.

## Set up

```sh
agedrop init --ci github      # in an existing repository: writes only the workflow
git add .github/workflows/agedrop-requests.yml
git commit -m "ci: notify about new requests for secrets"
git push
```

`.github/workflows/agedrop-requests.yml` runs on pushes to the default branch that touch `requests/**`. It runs
`agedrop notify --since <the commit before the push>`, so each new request is announced once. Then add the
repository secrets for one or more of the targets below (*Settings → Secrets and variables → Actions*, or
`gh secret set <NAME>`).

The workflow uses `runs-on: ubuntu-latest`. For self-hosted runners, change `runs-on` to their labels. A runner
needs Node 22 (the workflow installs it with `actions/setup-node`) and network access to npm and the target.

A notification holds the scope, the name, the reason (up to 500 characters), the requester and a link, never a
value and never the `generate` hint. The reason is written by whoever filed the request, so treat it as a claim
and decide in the fulfil form.

## ntfy

[ntfy](https://ntfy.sh) pushes to the ntfy app on a phone or to a browser, with no account needed on ntfy.sh.

1. Pick a topic name nobody can guess, since anyone who knows a topic on ntfy.sh can read it:
   `echo "agedrop-$(openssl rand -hex 12)"`.
2. Subscribe to it in the ntfy app (*+* → topic name) or at `https://ntfy.sh/<topic>`.
3. `gh secret set AGEDROP_NTFY_URL --body "https://ntfy.sh/<topic>"`.
4. With a self-hosted ntfy server or a protected topic, also
   `gh secret set AGEDROP_NTFY_TOKEN --body "tk_…"`, an ntfy access token with write access to the topic.

Tapping the notification opens the fulfil form in the web UI.

Try it from your machine first: `AGEDROP_NTFY_URL=https://ntfy.sh/<topic> agedrop notify` sends every open
request, and `agedrop notify --dry-run` prints what would be sent.

## Webhook

Anything that takes a JSON `POST`: a Slack or Discord relay, Home Assistant, n8n, your own service.

```sh
gh secret set AGEDROP_WEBHOOK_URL --body "https://example.com/hooks/agedrop"
gh secret set AGEDROP_WEBHOOK_SECRET --body "$(openssl rand -hex 32)"   # optional
```

The body:

```json
{
  "type": "agedrop.request",
  "repository": "owner/secrets",
  "request": {
    "id": "k3x9abcd",
    "scope": "mini/hq",
    "name": "VAPID_PRIVATE_KEY",
    "reason": "Web Push signing key for plan #50",
    "requested_by": "hq plan session #52",
    "created": "2026-11-09T10:00:00Z"
  },
  "rotation": false,
  "url": "https://app.agedrop.dev/#/requests/k3x9abcd?repo=owner%2Fsecrets",
  "title": "Secret requested: mini/hq/VAPID_PRIVATE_KEY",
  "message": "Web Push signing key for plan #50\nby hq plan session #52"
}
```

With a secret, the request has `X-Agedrop-Signature: sha256=<hex>`, the HMAC-SHA256 of the raw body keyed with
the secret. Check it before trusting the body, with a constant-time comparison:

```js
import { createHmac, timingSafeEqual } from "node:crypto";
const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`);
const given = Buffer.from(request.headers["x-agedrop-signature"] ?? "");
const valid = given.length === expected.length && timingSafeEqual(given, expected);
```

The receiver should answer with a `2xx` status within 15 seconds. Anything else fails the job, so you see it in
the Actions tab.

## Web Push

For an app that already has push subscriptions, such as a dashboard installed as a PWA. agedrop sends the
webhook's JSON body as the push message, encrypted to each subscription (RFC 8291) and signed with your VAPID
key (RFC 8292). Your service worker shows it:

```js
self.addEventListener("push", (event) => {
  const n = event.data.json();
  event.waitUntil(self.registration.showNotification(n.title, { body: n.message, data: n.url }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  if (event.notification.data) event.waitUntil(clients.openWindow(event.notification.data));
});
```

1. Use the VAPID key pair your app subscribes with, or make one with `npx web-push generate-vapid-keys`. The
   app passes the public key as `applicationServerKey` to `pushManager.subscribe()`.
2. Store the subscription the browser returns (`JSON.stringify(subscription)`), or a JSON array of several:
   `gh secret set AGEDROP_WEBPUSH_SUBSCRIPTIONS < subscriptions.json`.
3. `gh secret set AGEDROP_VAPID_PRIVATE_KEY --body "<private key>"` (base64url, as `web-push` prints it).
4. `gh secret set AGEDROP_VAPID_SUBJECT --body "mailto:you@example.com"`: push services, Apple's included,
   need a contact.

All three are needed. When a push service answers `404` or `410`, the browser has dropped that subscription:
the job fails with `HTTP 410: the push service dropped the subscription`, and the stored subscription should
be replaced. A subscription changes when the browser renews it, so a secret that holds it must be updated by
hand; an app that manages many subscriptions should rather take the webhook and send pushes itself.

## Other CI

`agedrop notify` is not tied to GitHub. Run it after a pull or a push in any CI with the same environment
variables: `agedrop notify --since "$PREVIOUS_COMMIT"`. Without `GITHUB_REPOSITORY` or
`--github <owner/name>`, a notification has no link, because the web UI works with GitHub repositories only.

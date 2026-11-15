#!/usr/bin/env bash
# One-time setup of agedrop's Cloudflare side, run by the owner in an interactive session on a laptop
# (it has the browser that `tofu login` and the Cloudflare dashboard need):
#
#   infra/bootstrap.sh --check   # read-only: tools, logins, tokens, Terraform Cloud workspace, tofu plan
#   infra/bootstrap.sh           # the same, then apply after a "yes", deploy both sites and verify them
#
# What it automates: the Terraform Cloud login and workspace (local execution, like lipelix/zmrdly), the
# GitHub token (taken from `gh auth token`, so no PAT to create), checking both Cloudflare tokens against the
# API, `tofu plan`/`apply`, the two deploy workflows, and checks of app.agedrop.dev, agedrop.dev and www.
# What it cannot: creating the two Cloudflare API tokens, which only the dashboard can do. It asks for them
# with hidden input and passes them to tofu as TF_VAR_* environment variables; it never writes them to disk.
#
# Needs bash 3.2+, tofu, gh (logged in with admin on lipelix/agedrop), curl and python3.
set -euo pipefail

REPO="lipelix/agedrop"
TFC_HOST="app.terraform.io"
TFC_ORG="lipelix"
TFC_WORKSPACE="agedrop"
DOMAIN="agedrop.dev"
CF_API="https://api.cloudflare.com/client/v4"

CHECK_ONLY=false
case "${1:-}" in
  --check) CHECK_ONLY=true ;;
  "") ;;
  *) echo "usage: $0 [--check]" >&2; exit 2 ;;
esac

cd "$(dirname "$0")"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok() { printf '   ok: %s\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

# ---------------------------------------------------------------------------------------------------- tools
step "Tools"
for tool in tofu gh curl python3; do
  command -v "$tool" >/dev/null || die "$tool is not installed"
done
ok "tofu $(tofu version | head -1 | awk '{print $2}'), gh, curl, python3"

# --------------------------------------------------------------------------------------------------- GitHub
step "GitHub ($REPO)"
gh auth status >/dev/null 2>&1 || die "gh is not logged in: run gh auth login"
[ "$(gh api "repos/$REPO" --jq .permissions.admin)" = "true" ] ||
  die "your gh login is not an admin of $REPO, so it cannot set Actions secrets"
TF_VAR_github_token="$(gh auth token)"
export TF_VAR_github_token
ok "using the gh login's token for the github provider (secrets and variables of $REPO)"

# ------------------------------------------------------------------------------------------ Terraform Cloud
step "Terraform Cloud ($TFC_ORG/$TFC_WORKSPACE)"
CREDENTIALS="$HOME/.terraform.d/credentials.tfrc.json"
tfc_token() {
  [ -f "$CREDENTIALS" ] || return 0
  json "d.get('credentials', {}).get('$TFC_HOST', {}).get('token', '')" <"$CREDENTIALS"
}
if [ -z "$(tfc_token)" ]; then
  $CHECK_ONLY && die "no Terraform Cloud login in $CREDENTIALS: run tofu login $TFC_HOST (opens a browser)"
  echo "   No Terraform Cloud login yet: tofu login opens a browser to create a user token."
  tofu login "$TFC_HOST"
fi
TFC_TOKEN="$(tfc_token)"
[ -n "$TFC_TOKEN" ] || die "tofu login did not store a token for $TFC_HOST"

tfc() {
  curl -sS -H "Authorization: Bearer $TFC_TOKEN" -H "Content-Type: application/vnd.api+json" "$@"
}
status="$(tfc -o "$WORK/workspace.json" -w '%{http_code}' \
  "https://$TFC_HOST/api/v2/organizations/$TFC_ORG/workspaces/$TFC_WORKSPACE")"
LOCAL_MODE='{"data":{"type":"workspaces","attributes":{"name":"'"$TFC_WORKSPACE"'","execution-mode":"local"}}}'
if [ "$status" = 404 ]; then
  $CHECK_ONLY && die "workspace $TFC_ORG/$TFC_WORKSPACE does not exist yet (the full run creates it)"
  tfc -o /dev/null -X POST -d "$LOCAL_MODE" "https://$TFC_HOST/api/v2/organizations/$TFC_ORG/workspaces"
  ok "created workspace $TFC_WORKSPACE with local execution"
elif [ "$status" = 200 ]; then
  mode="$(json "d['data']['attributes']['execution-mode']" <"$WORK/workspace.json")"
  if [ "$mode" != local ]; then
    $CHECK_ONLY && die "workspace $TFC_WORKSPACE runs in $mode mode; the full run switches it to local"
    tfc -o /dev/null -X PATCH -d "$LOCAL_MODE" \
      "https://$TFC_HOST/api/v2/organizations/$TFC_ORG/workspaces/$TFC_WORKSPACE"
    ok "switched workspace $TFC_WORKSPACE from $mode to local execution"
  else
    ok "workspace $TFC_WORKSPACE exists, local execution"
  fi
else
  die "Terraform Cloud answered $status for $TFC_ORG/$TFC_WORKSPACE (is the login for organization $TFC_ORG?)"
fi

# ------------------------------------------------------------------------------------------------ Cloudflare
step "Cloudflare tokens (agedrop.dev account only, not a CF_API_TOKEN from your shell)"
cf() { curl -sS -H "Authorization: Bearer $1" "$CF_API$2"; }
cf_ok() { json "d.get('success') is True and $1"; }

ask_token() { # $1 = variable name, $2 = what to create
  local name="$1" value=""
  if [ -n "${!name:-}" ]; then
    ok "$name taken from the environment"
    return
  fi
  printf '\n   Create it at https://dash.cloudflare.com/profile/api-tokens -> Create Token -> Custom token:\n%s\n' "$2"
  if [ "$(uname)" = Darwin ]; then open "https://dash.cloudflare.com/profile/api-tokens" || true; fi
  read -rsp "   Paste $name (input hidden): " value
  echo
  [ -n "$value" ] || die "$name is empty"
  export "$name=$value"
}

ask_token TF_VAR_cloudflare_api_token "      name: agedrop infra apply
      Zone · DNS · Edit, and Zone · Single Redirect · Edit   (Zone Resources: Include · Specific zone · $DOMAIN)
      Account · Cloudflare Pages · Edit                        (Account Resources: your personal account)
      a short TTL is fine: it is only used for this apply"
[ "$(cf "$TF_VAR_cloudflare_api_token" /user/tokens/verify | cf_ok "d['result']['status'] == 'active'")" = True ] ||
  die "the apply token is not active"
cf "$TF_VAR_cloudflare_api_token" "/zones?name=$DOMAIN" >"$WORK/zone.json"
[ "$(cf_ok "len(d['result']) == 1" <"$WORK/zone.json")" = True ] ||
  die "the apply token cannot see the zone $DOMAIN: give it Zone resources for $DOMAIN"
ACCOUNT_ID="$(json "d['result'][0]['account']['id']" <"$WORK/zone.json")"
ACCOUNT_NAME="$(json "d['result'][0]['account']['name']" <"$WORK/zone.json")"
[ "$(cf "$TF_VAR_cloudflare_api_token" "/accounts/$ACCOUNT_ID/pages/projects" | cf_ok True)" = True ] ||
  die "the apply token cannot read Pages in account $ACCOUNT_NAME: add Account · Cloudflare Pages · Edit"
ok "apply token: zone $DOMAIN in account \"$ACCOUNT_NAME\" ($ACCOUNT_ID), Pages readable"
read -rp "   Is \"$ACCOUNT_NAME\" your PERSONAL Cloudflare account? [y/N] " answer
[ "$answer" = y ] || [ "$answer" = Y ] || die "stopped: wrong Cloudflare account"

ask_token TF_VAR_pages_deploy_token "      name: agedrop CI pages deploy
      Account · Cloudflare Pages · Edit   (Account Resources: the same account), nothing else, no expiry needed
      it becomes the repository secret CLOUDFLARE_API_TOKEN for the deploy workflows"
[ "$(cf "$TF_VAR_pages_deploy_token" /user/tokens/verify | cf_ok "d['result']['status'] == 'active'")" = True ] ||
  die "the deploy token is not active"
[ "$(cf "$TF_VAR_pages_deploy_token" "/accounts/$ACCOUNT_ID/pages/projects" | cf_ok True)" = True ] ||
  die "the deploy token cannot use Pages in account $ACCOUNT_NAME"
[ "$(cf "$TF_VAR_pages_deploy_token" "/zones?name=$DOMAIN" | cf_ok "len(d['result']) == 0")" = True ] ||
  echo "   warning: the deploy token can also see the zone $DOMAIN; it only needs Pages"
ok "deploy token: Pages in the same account"

# ------------------------------------------------------------------------------------------------------ plan
step "tofu plan"
tofu init -input=false >/dev/null
# The plan file holds the variables, tokens included, so it lives in the temporary directory only.
tofu plan -input=false -out="$WORK/agedrop.tfplan"
tofu show -json "$WORK/agedrop.tfplan" >"$WORK/plan.json"
summary="$(python3 - "$WORK/plan.json" <<'EOF'
import json, sys
plan = json.load(open(sys.argv[1]))
risky = []
counts = {}
for change in plan.get("resource_changes", []):
    actions = change["change"]["actions"]
    key = "+".join(actions)
    counts[key] = counts.get(key, 0) + 1
    if "delete" in actions:
        risky.append(change["address"])
print(", ".join(f"{n} {k}" for k, n in sorted(counts.items())) or "no changes")
print(" ".join(risky))
EOF
)"
changes="$(echo "$summary" | sed -n 1p)"
deletes="$(echo "$summary" | sed -n 2p)"
ok "plan: $changes"

if $CHECK_ONLY; then
  echo
  echo "Check passed. Run $0 without --check to apply, deploy and verify."
  exit 0
fi

# ----------------------------------------------------------------------------------------------------- apply
step "tofu apply"
if [ -n "$deletes" ]; then
  echo "   The plan DELETES or REPLACES: $deletes"
  read -rp "   Type 'apply anyway' to go on: " answer
  [ "$answer" = "apply anyway" ] || die "stopped before apply"
elif [ "$changes" != "no changes" ]; then
  read -rp "   Apply this plan? [y/N] " answer
  [ "$answer" = y ] || [ "$answer" = Y ] || die "stopped before apply"
fi
[ "$changes" = "no changes" ] || tofu apply -input=false "$WORK/agedrop.tfplan"
gh secret list --repo "$REPO" | grep -q '^CLOUDFLARE_API_TOKEN' || die "repo secret CLOUDFLARE_API_TOKEN is missing"
[ "$(gh variable get CLOUDFLARE_ACCOUNT_ID --repo "$REPO")" = "$ACCOUNT_ID" ] ||
  die "repo variable CLOUDFLARE_ACCOUNT_ID is not $ACCOUNT_ID"
ok "repo secret CLOUDFLARE_API_TOKEN and variable CLOUDFLARE_ACCOUNT_ID are set"

# ---------------------------------------------------------------------------------------------------- deploy
step "Deploy both sites from main"
for workflow in deploy-web.yml deploy-site.yml; do
  before="$(gh run list --repo "$REPO" --workflow "$workflow" --limit 1 --json databaseId --jq '.[0].databaseId // 0')"
  gh workflow run "$workflow" --repo "$REPO" --ref main
  run=""
  for _ in $(seq 1 30); do
    sleep 4
    run="$(gh run list --repo "$REPO" --workflow "$workflow" --limit 1 --json databaseId --jq '.[0].databaseId // 0')"
    [ "$run" != "$before" ] && break
  done
  [ -n "$run" ] && [ "$run" != "$before" ] || die "$workflow did not start"
  gh run watch "$run" --repo "$REPO" --exit-status >/dev/null || die "$workflow failed: gh run view $run --repo $REPO --log-failed"
  ok "$workflow passed (run $run)"
done

# ---------------------------------------------------------------------------------------------------- verify
step "Verify (a new custom domain can take a few minutes to get its certificate)"
wait_for() { # $1 = url, $2 = expected status
  local code=""
  for _ in $(seq 1 60); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "$1" || true)"
    [ "$code" = "$2" ] && return 0
    sleep 10
  done
  die "$1 answered ${code:-nothing}, expected $2"
}
wait_for "https://app.$DOMAIN/" 200
curl -sSI "https://app.$DOMAIN/" | grep -qi "content-security-policy:.*connect-src https://api.github.com" ||
  die "https://app.$DOMAIN/ has no CSP limiting connect-src to api.github.com"
ok "https://app.$DOMAIN/ is up with its CSP"
wait_for "https://$DOMAIN/" 200
ok "https://$DOMAIN/ is up"
wait_for "https://www.$DOMAIN/spec?x=1" 301
location="$(curl -sSI "https://www.$DOMAIN/spec?x=1" | awk 'tolower($1)=="location:"{print $2}' | tr -d '\r')"
[ "$location" = "https://$DOMAIN/spec?x=1" ] || die "www redirects to $location"
ok "https://www.$DOMAIN/ redirects to the apex, keeping path and query"

if tofu plan -input=false -detailed-exitcode -lock=false >/dev/null; then
  ok "tofu plan shows no changes"
else
  echo "   warning: tofu plan still shows changes after apply; run tofu plan in infra/ and look"
fi

echo
echo "Done: https://app.$DOMAIN and https://$DOMAIN are live. Next: open https://app.$DOMAIN on the iPhone."

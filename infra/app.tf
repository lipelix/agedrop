# The static web UI (web/, SPEC.md § Web UI) on its own origin, app.agedrop.dev, so nothing else on
# agedrop.dev shares its storage. CI uploads builds directly (wrangler pages deploy), so the project
# has no git source and Cloudflare never builds the repository itself.

data "cloudflare_zone" "agedrop" {
  name = var.domain
}

locals {
  account_id = data.cloudflare_zone.agedrop.account_id
  app_host   = "app.${var.domain}"
}

resource "cloudflare_pages_project" "app" {
  account_id        = local.account_id
  name              = "agedrop-app"
  production_branch = "main"
}

resource "cloudflare_pages_domain" "app" {
  account_id   = local.account_id
  project_name = cloudflare_pages_project.app.name
  domain       = local.app_host
}

resource "cloudflare_record" "app" {
  zone_id = data.cloudflare_zone.agedrop.id
  name    = "app"
  type    = "CNAME"
  content = cloudflare_pages_project.app.subdomain
  proxied = true
  comment = "agedrop web UI (Cloudflare Pages project agedrop-app), managed in lipelix/agedrop infra/"
}

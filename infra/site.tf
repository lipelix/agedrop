# The landing page (site/) on the apex, agedrop.dev, in its own Pages project so it shares nothing with the
# app on app.agedrop.dev. CI uploads it directly (.github/workflows/deploy-site.yml), like the app.

locals {
  site_origin = "https://${var.domain}"
}

resource "cloudflare_pages_project" "site" {
  account_id        = local.account_id
  name              = "agedrop-site"
  production_branch = "main"
}

resource "cloudflare_record" "site" {
  zone_id = data.cloudflare_zone.agedrop.id
  name    = var.domain
  type    = "CNAME" # flattened at the apex by Cloudflare
  content = cloudflare_pages_project.site.subdomain
  proxied = true
  comment = "agedrop landing page (Cloudflare Pages project agedrop-site), managed in lipelix/agedrop infra/"
}

resource "cloudflare_pages_domain" "site" {
  account_id   = local.account_id
  project_name = cloudflare_pages_project.site.name
  domain       = var.domain

  depends_on = [cloudflare_record.site]
}

# www only redirects, so the record just has to be proxied for the rule below to see the request.
resource "cloudflare_record" "www" {
  zone_id = data.cloudflare_zone.agedrop.id
  name    = "www"
  type    = "CNAME"
  content = var.domain
  proxied = true
  comment = "Redirected to the apex (cloudflare_ruleset.redirects in infra/site.tf)"
}

# www.agedrop.dev → https://agedrop.dev, keeping path and query. Single Redirects are the zone's
# http_request_dynamic_redirect entrypoint; the free plan allows ten rules, this uses one.
resource "cloudflare_ruleset" "redirects" {
  zone_id     = data.cloudflare_zone.agedrop.id
  name        = "agedrop redirects"
  description = "Canonical host redirects"
  kind        = "zone"
  phase       = "http_request_dynamic_redirect"

  rules {
    action      = "redirect"
    description = "www to apex"
    expression  = "(http.host eq \"www.${var.domain}\")"
    enabled     = true

    action_parameters {
      from_value {
        status_code           = 301
        preserve_query_string = true

        target_url {
          expression = "concat(\"${local.site_origin}\", http.request.uri.path)"
        }
      }
    }
  }
}

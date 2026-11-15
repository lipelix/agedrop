# What .github/workflows/deploy-web.yml and deploy-site.yml read, derived from this stack.

resource "github_actions_secret" "cloudflare_api_token" {
  repository      = var.github_repo
  secret_name     = "CLOUDFLARE_API_TOKEN"
  plaintext_value = var.pages_deploy_token
}

resource "github_actions_variable" "cloudflare_account_id" {
  repository    = var.github_repo
  variable_name = "CLOUDFLARE_ACCOUNT_ID"
  value         = local.account_id
}

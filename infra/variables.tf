# Cloudflare account that owns agedrop.dev. Needs Zone · DNS · Edit and Zone · Single Redirect · Edit
# on agedrop.dev, and Account · Cloudflare Pages · Edit. Used only to apply this stack.
variable "cloudflare_api_token" {
  type      = string
  sensitive = true
}

# A second, narrower token for CI: Account · Cloudflare Pages · Edit only. Stored as the repository
# secret CLOUDFLARE_API_TOKEN, which .github/workflows/deploy-web.yml and deploy-site.yml use.
variable "pages_deploy_token" {
  type      = string
  sensitive = true
}

# Fine-grained PAT on lipelix/agedrop only: Secrets and Variables: Read and write, Metadata: Read.
variable "github_token" {
  type      = string
  sensitive = true
}

variable "github_owner" {
  type    = string
  default = "lipelix"
}

variable "github_repo" {
  type    = string
  default = "agedrop"
}

# Registered on Cloudflare, so the zone already exists in the personal account.
variable "domain" {
  type    = string
  default = "agedrop.dev"
}

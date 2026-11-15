output "app_url" {
  value = "https://${local.app_host}"
}

output "pages_subdomain" {
  value = cloudflare_pages_project.app.subdomain
}

output "site_url" {
  value = local.site_origin
}

output "site_pages_subdomain" {
  value = cloudflare_pages_project.site.subdomain
}

# Each public name is proxied, so a visitor reaches Cloudflare's edge and only
# the edge reaches the origin.
resource "cloudflare_dns_record" "public_name" {
  for_each = var.environments

  zone_id = var.cloudflare_zone_id
  name    = each.value.public_name
  type    = "CNAME"
  content = aws_elastic_beanstalk_environment.hosted[each.key].cname
  proxied = true
  ttl     = 1

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_zone_setting" "ssl" {
  zone_id    = var.cloudflare_zone_id
  setting_id = "ssl"
  value      = "strict"
}

resource "cloudflare_zone_setting" "always_use_https" {
  zone_id    = var.cloudflare_zone_id
  setting_id = "always_use_https"
  value      = "on"
}

resource "cloudflare_zone_setting" "hsts" {
  zone_id    = var.cloudflare_zone_id
  setting_id = "security_header"
  value = {
    strict_transport_security = {
      enabled            = true
      max_age            = 2592000
      include_subdomains = false
      preload            = false
      nosniff            = false
    }
  }
}

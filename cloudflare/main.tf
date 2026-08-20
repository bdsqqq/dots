terraform {
  required_version = "= 1.12.3"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "= 5.23.0"
    }
  }

  encryption {
    key_provider "pbkdf2" "repo_state" {
      passphrase               = var.state_passphrase
      encrypted_metadata_alias = "cloudflare-repo-state"
    }

    method "aes_gcm" "repo_state" {
      keys = key_provider.pbkdf2.repo_state
    }

    state {
      method   = method.aes_gcm.repo_state
      enforced = true
    }

    plan {
      method   = method.aes_gcm.repo_state
      enforced = true
    }
  }
}

provider "cloudflare" {}

locals {
  account_id       = "7c1219e69201df160c85fc5e030efe36"
  zone_id          = "f6f9ce4af454779e269f70c8e1e8d158"
  access_team_name = "solitary-darkness-2655"
  audience_emails = {
    family = var.family_emails
  }
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "app" {
  for_each = var.apps

  account_id    = local.account_id
  name          = each.value.cloudflare.tunnelName
  config_src    = "local"
  tunnel_secret = lookup(var.tunnel_secrets, each.key, null)

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_dns_record" "app" {
  for_each = var.apps

  zone_id = local.zone_id
  name    = each.value.cloudflare.hostname
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.app[each.key].id}.cfargotunnel.com"
  ttl     = 1
  proxied = true

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_zero_trust_access_application" "app" {
  for_each = var.apps

  account_id = local.account_id
  name       = each.value.cloudflare.accessName
  domain     = each.value.cloudflare.hostname
  type       = "self_hosted"

  app_launcher_visible       = false
  enable_binding_cookie      = true
  http_only_cookie_attribute = true
  same_site_cookie_attribute = "strict"
  session_duration           = "720h"

  policies = [{
    name       = each.value.cloudflare.audience
    decision   = "allow"
    precedence = 1
    include = [
      for address in sort(tolist(local.audience_emails[each.value.cloudflare.audience])) : {
        email = { email = address }
      }
    ]
  }]

  lifecycle {
    prevent_destroy = true
  }
}

moved {
  from = cloudflare_zero_trust_tunnel_cloudflared.tailnet_apps
  to   = cloudflare_zero_trust_tunnel_cloudflared.app["photos"]
}

moved {
  from = cloudflare_zero_trust_tunnel_cloudflared.html_stuff
  to   = cloudflare_zero_trust_tunnel_cloudflared.app["html-stuff"]
}

moved {
  from = cloudflare_dns_record.family_photos
  to   = cloudflare_dns_record.app["photos"]
}

moved {
  from = cloudflare_dns_record.family_html_stuff
  to   = cloudflare_dns_record.app["html-stuff"]
}

moved {
  from = cloudflare_zero_trust_access_application.family_photos
  to   = cloudflare_zero_trust_access_application.app["photos"]
}

moved {
  from = cloudflare_zero_trust_access_application.family_html_stuff
  to   = cloudflare_zero_trust_access_application.app["html-stuff"]
}

output "runtime_bindings" {
  description = "Non-secret identifiers consumed by relay connector deployments."
  value = {
    for name, app in var.apps : name => {
      tunnelId       = cloudflare_zero_trust_tunnel_cloudflared.app[name].id
      accessAudience = cloudflare_zero_trust_access_application.app[name].aud
      accountTag     = local.access_team_name
    }
  }
}

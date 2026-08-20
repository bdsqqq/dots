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
  account_id   = "7c1219e69201df160c85fc5e030efe36"
  zone_id      = "f6f9ce4af454779e269f70c8e1e8d158"
  tunnel_id    = "88b54fce-fae0-4ca2-9c56-41ab61cedf3f"
  photo_domain = "fotos.igorbedesqui.com"
  stuff_domain = "stuff.igorbedesqui.com"
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "tailnet_apps" {
  account_id = local.account_id
  name       = "tailnet-apps"
  config_src = "local"

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_dns_record" "family_photos" {
  zone_id = local.zone_id
  name    = local.photo_domain
  type    = "CNAME"
  content = "${local.tunnel_id}.cfargotunnel.com"
  ttl     = 1
  proxied = true

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_zero_trust_access_application" "family_photos" {
  account_id = local.account_id
  name       = "family photos"
  domain     = local.photo_domain
  type       = "self_hosted"

  app_launcher_visible       = false
  enable_binding_cookie      = true
  http_only_cookie_attribute = true
  same_site_cookie_attribute = "strict"
  session_duration           = "720h"

  policies = [{
    name       = "family"
    decision   = "allow"
    precedence = 1
    include = [
      for address in sort(tolist(var.family_emails)) : {
        email = { email = address }
      }
    ]
  }]

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "html_stuff" {
  account_id    = local.account_id
  name          = "html-stuff"
  config_src    = "local"
  tunnel_secret = var.html_stuff_tunnel_secret

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_dns_record" "family_html_stuff" {
  zone_id = local.zone_id
  name    = local.stuff_domain
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.html_stuff.id}.cfargotunnel.com"
  ttl     = 1
  proxied = true

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_zero_trust_access_application" "family_html_stuff" {
  account_id = local.account_id
  name       = "family html stuff"
  domain     = local.stuff_domain
  type       = "self_hosted"

  app_launcher_visible       = false
  enable_binding_cookie      = true
  http_only_cookie_attribute = true
  same_site_cookie_attribute = "strict"
  session_duration           = "720h"

  policies = [{
    name       = "family"
    decision   = "allow"
    precedence = 1
    include = [
      for address in sort(tolist(var.family_emails)) : {
        email = { email = address }
      }
    ]
  }]

  lifecycle {
    prevent_destroy = true
  }
}

output "html_stuff_tunnel_id" {
  description = "Tunnel UUID required by the connector deployment."
  value       = cloudflare_zero_trust_tunnel_cloudflared.html_stuff.id
}

output "html_stuff_access_aud" {
  description = "Access audience required by the connector JWT validator."
  value       = cloudflare_zero_trust_access_application.family_html_stuff.aud
}

import {
  to = cloudflare_zero_trust_tunnel_cloudflared.tailnet_apps
  id = "${local.account_id}/${local.tunnel_id}"
}

import {
  to = cloudflare_dns_record.family_photos
  id = "${local.zone_id}/de3702d4c5a4e0b52d4a09b6b0a2fc5d"
}

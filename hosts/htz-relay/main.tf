terraform {
  required_version = "= 1.12.3"

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "= 1.66.1"
    }
  }

  encryption {
    key_provider "pbkdf2" "repo_state" {
      passphrase               = var.state_passphrase
      encrypted_metadata_alias = "htz-relay-repo-state"
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

provider "hcloud" {}

variable "state_passphrase" {
  description = "Passphrase for the encrypted state and plan files."
  type        = string
  sensitive   = true
}

resource "hcloud_primary_ip" "ipv4" {
  name              = "primary_ip-103618518"
  type              = "ipv4"
  location          = "nbg1"
  auto_delete       = false
  delete_protection = true

  lifecycle {
    prevent_destroy = true
  }
}

resource "hcloud_primary_ip" "ipv6" {
  name              = "primary_ip-103618519"
  type              = "ipv6"
  location          = "nbg1"
  auto_delete       = false
  delete_protection = true

  lifecycle {
    prevent_destroy = true
  }
}

resource "hcloud_server" "this" {
  name        = "htz-relay"
  image       = "ubuntu-22.04"
  server_type = "cx22"
  location    = "nbg1"
  backups     = true

  delete_protection  = true
  rebuild_protection = true

  public_net {
    ipv4         = hcloud_primary_ip.ipv4.id
    ipv4_enabled = true
    ipv6         = hcloud_primary_ip.ipv6.id
    ipv6_enabled = true
  }

  lifecycle {
    prevent_destroy = true
    # Imports do not hydrate these creation-time or client-side defaults.
    # Keep them for replacement while making adoption of the live server inert.
    ignore_changes = [
      ignore_remote_firewall_ids,
      keep_disk,
      public_net,
      shutdown_before_deletion,
    ]
  }
}

resource "hcloud_volume" "storage" {
  name              = "storage-01"
  size              = 50
  location          = "nbg1"
  server_id         = hcloud_server.this.id
  automount         = false
  delete_protection = true

  lifecycle {
    prevent_destroy = true
  }
}

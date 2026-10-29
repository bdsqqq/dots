terraform {
  required_version = "= 1.12.3"

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "= 1.66.1"
    }
  }

  encryption {
    key_provider "pbkdf2" "host_state" {
      passphrase               = var.state_passphrase
      encrypted_metadata_alias = "htz-xfs-lab-host-state-v1"
    }

    method "aes_gcm" "host_state" {
      keys = key_provider.pbkdf2.host_state
    }

    state {
      method   = method.aes_gcm.host_state
      enforced = true
    }

    plan {
      method   = method.aes_gcm.host_state
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

data "hcloud_ssh_key" "operator" {
  name = "bdsqqq@mbp14"
}

resource "hcloud_server" "this" {
  name        = "htz-xfs-lab"
  image       = "ubuntu-24.04"
  server_type = "cx23"
  location    = "nbg1"
  ssh_keys    = [data.hcloud_ssh_key.operator.id]
  backups     = false

  labels = {
    role      = "storage-lab"
    lifecycle = "disposable"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "hcloud_server" "lab" {
  name        = "htz-lab"
  image       = "ubuntu-24.04"
  server_type = "cx33"
  location    = "nbg1"
  ssh_keys    = [data.hcloud_ssh_key.operator.id]
  backups     = false

  delete_protection  = true
  rebuild_protection = true

  labels = {
    role = "storage-lab"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "hcloud_volume" "vdo" {
  name = "htz-xfs-lab-vdo"
  size = 50
  # The independent host must never take this active lab volume.
  server_id         = hcloud_server.this.id
  automount         = false
  delete_protection = true

  labels = {
    role      = "xfs-vdo-lab"
    lifecycle = "persistent"
  }

  lifecycle {
    prevent_destroy = true
  }
}

output "ipv4_address" {
  value = hcloud_server.this.ipv4_address
}

output "lab_ipv4_address" {
  value = hcloud_server.lab.ipv4_address
}

output "volume_id" {
  value = hcloud_volume.vdo.id
}

output "volume_linux_device" {
  value = hcloud_volume.vdo.linux_device
}

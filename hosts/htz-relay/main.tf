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

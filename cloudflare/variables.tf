variable "state_passphrase" {
  description = "Passphrase for the encrypted state and plan files."
  type        = string
  sensitive   = true
}

variable "family_emails" {
  description = "Private identities allowed through the family Access policy."
  type        = set(string)
  sensitive   = true

  validation {
    condition     = length(var.family_emails) > 0
    error_message = "At least one family identity is required."
  }
}

variable "owner_email" {
  description = "Private identity allowed through owner-only Access policies."
  type        = string
  sensitive   = true

  validation {
    condition     = length(trimspace(var.owner_email)) > 0
    error_message = "An owner identity is required."
  }
}

variable "apps" {
  description = "Generated publication intent from app-colocated declarations."
  type = map(object({
    title = string
    cloudflare = object({
      hostname       = string
      audience       = string
      connectorTrust = string
      tunnelName     = string
      accessName     = string
    })
  }))
}

variable "tunnel_secrets" {
  description = "Optional base64 tunnel secrets keyed by app ID."
  type        = map(string)
  sensitive   = true
  default     = {}
}

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

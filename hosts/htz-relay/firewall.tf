# No rules means deny all unsolicited ingress (IPv4/IPv6), allow egress.
# Tailscale and Cloudflare use outbound connections; console recovery is separate.
resource "hcloud_firewall" "private_ingress" {
  name = "htz-relay-private-ingress"

  apply_to {
    server = hcloud_server.this.id
  }

  lifecycle {
    prevent_destroy = true

    # hcloud 1.66.1 skips SetRules for an empty desired set. Fail loudly if
    # remote drift adds an allow rule; never report a successful closed edge.
    postcondition {
      condition     = length(self.rule) == 0
      error_message = "Private ingress firewall has unexpected rules. Clear them explicitly with hcloud firewall set-rules, then re-plan."
    }
  }
}

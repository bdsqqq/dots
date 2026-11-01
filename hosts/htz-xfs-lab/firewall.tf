# Keep a separate edge firewall per host for staged rollout and recovery.
# Empty rules deny unsolicited IPv4/IPv6 ingress without restricting egress.
resource "hcloud_firewall" "private_ingress" {
  for_each = {
    htz-xfs-lab = hcloud_server.this.id
    htz-lab     = hcloud_server.lab.id
  }

  name = "${each.key}-private-ingress"

  apply_to {
    server = each.value
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

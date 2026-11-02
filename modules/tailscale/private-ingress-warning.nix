{ config, lib, ... }:

{
  warnings =
    lib.optional (!(config.my.privateIngress.imported or false))
      "${config.networking.hostName}: missing modules/tailscale/private-ingress.nix import; public ingress is not covered by the private-ingress policy.";
}

{ config, lib, ... }:

{
  # A read-only marker lets the fleet diagnostic see indirect imports and
  # disabledModules without guessing from source text or firewall defaults.
  options.my.privateIngress.imported = lib.mkOption {
    type = lib.types.bool;
    default = true;
    readOnly = true;
    internal = true;
    description = "Whether the private-ingress policy module is imported.";
  };

  config = {
    networking.firewall = {
      enable = true;
      allowPing = false;
      trustedInterfaces = [ config.services.tailscale.interfaceName ];
      checkReversePath = "loose";

      # Lists merge across modules: an empty normal-priority list does not close SSH.
      allowedTCPPorts = lib.mkForce [ ];
      allowedUDPPorts = lib.mkForce [ ];
      allowedTCPPortRanges = lib.mkForce [ ];
      allowedUDPPortRanges = lib.mkForce [ ];
    };

    services.openssh.openFirewall = false;
    services.tailscale = {
      openFirewall = false;
      # tailscaled otherwise inserts an ACCEPT for UDP 41641 ahead of NixOS's
      # firewall, even with openFirewall=false. NixOS owns filtering here; trust
      # the decrypted interface, not source addresses claimed on the public NIC.
      extraUpFlags = [ "--netfilter-mode=off" ];
      extraSetFlags = [ "--netfilter-mode=off" ];
    };
  };
}

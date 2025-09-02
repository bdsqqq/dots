# tailscale firewall configuration using native nixos firewall
{ config, pkgs, lib, ... }:

{
  # re-enable nixos firewall with tailscale-friendly configuration
  networking.firewall = {
    enable = true;
    
    # allow ssh
    allowedTCPPorts = [ 22 ];
    
    # allow syncthing ports
    allowedTCPPortRanges = [
      { from = 22000; to = 22000; }   # syncthing
      { from = 8384; to = 8384; }     # syncthing web ui
    ];
    allowedUDPPorts = [ 21027 22000 ];  # syncthing discovery and transfers
    
    # allow all traffic on tailscale interface
    trustedInterfaces = [ "tailscale0" ];
    
    # allow tailscale traffic
    checkReversePath = "loose";  # required for tailscale
    
    # additional tailscale-specific rules
    extraCommands = ''
      # allow tailscale subnet routing if needed
      iptables -A INPUT -i tailscale0 -j ACCEPT
      iptables -A OUTPUT -o tailscale0 -j ACCEPT
    '';
    
    extraStopCommands = ''
      # cleanup tailscale rules on firewall stop
      iptables -D INPUT -i tailscale0 -j ACCEPT 2>/dev/null || true
      iptables -D OUTPUT -o tailscale0 -j ACCEPT 2>/dev/null || true
    '';
  };
}
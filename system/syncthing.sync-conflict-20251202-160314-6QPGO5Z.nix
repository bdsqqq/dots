{ lib, pkgs, hostSystem ? null, ... }:
let
  system = hostSystem;
  isLinux = lib.hasInfix "linux" system;
  isDarwin = lib.hasInfix "darwin" system;
in
if isLinux then {
  # NixOS uses system service; declarative folder/device config in host files
  services.syncthing = {
    enable = true;
    user = "bdsqqq";
    dataDir = "/home/bdsqqq";
    configDir = "/home/bdsqqq/.config/syncthing";
    guiAddress = "0.0.0.0:8384";
  };
  
  networking.firewall.interfaces."tailscale0".allowedTCPPorts = [ 8384 22000 ];
  networking.firewall.interfaces."tailscale0".allowedUDPPorts = [ 22000 21027 ];
} else if isDarwin then {
  # darwin: syncthing managed via home-manager's services.syncthing in host config
  # (home-manager creates launchd agent automatically)
} else {}

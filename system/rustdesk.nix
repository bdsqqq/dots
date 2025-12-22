{ lib, pkgs, hostSystem ? null, ... }:
let
  system = hostSystem;
  isLinux = system != null && lib.hasInfix "linux" system;
  isDarwin = system != null && lib.hasInfix "darwin" system;
in
if isLinux then {
  environment.systemPackages = [ pkgs.rustdesk ];
  
  # allow direct IP access port on tailscale interface only
  networking.firewall.interfaces."tailscale0".allowedTCPPorts = [ 21118 ];
} else if isDarwin then {
  # use homebrew cask on darwin (nix package has platform detection issues)
  homebrew.casks = [ "rustdesk" ];
} else {}

{ lib, pkgs, hostSystem ? null, ... }:
let
  system = hostSystem;
  isLinux = system != null && lib.hasInfix "linux" system;
  isDarwin = system != null && lib.hasInfix "darwin" system;
  
  # rustdesk config for direct IP access via tailnet
  # whitelist allows entire tailscale CGNAT range (100.64.0.0/10)
  rustdeskConfig = ''
    [options]
    direct-server = 'Y'
    direct-access-port = '21118'
    whitelist = '100.64.0.0/10'
  '';
in
if isLinux then {
  environment.systemPackages = [ pkgs.rustdesk ];
  
  # allow direct IP access port on tailscale interface only
  networking.firewall.interfaces."tailscale0".allowedTCPPorts = [ 21118 ];
  
  # declarative rustdesk config via home-manager
  home-manager.users.bdsqqq.home.file.".config/rustdesk/RustDesk2.toml".text = rustdeskConfig;
} else if isDarwin then {
  # use homebrew cask on darwin (nix package has platform detection issues)
  homebrew.casks = [ "rustdesk" ];
  
  # declarative rustdesk config via home-manager
  home-manager.users.bdsqqq.home.file.".config/rustdesk/RustDesk2.toml".text = rustdeskConfig;
} else {}

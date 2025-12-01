{ lib, pkgs, hostSystem ? null, ... }:
let
  system = hostSystem;
  isLinux = lib.hasInfix "linux" system;
  isDarwin = lib.hasInfix "darwin" system;
in
if isLinux then {
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
  launchd.user.agents.syncthing = {
    serviceConfig = {
      Label = "com.bdsqqq.syncthing";
      ProgramArguments = [
        "${pkgs.syncthing}/bin/syncthing"
        "-no-browser"
        "-home"
        "/Users/bdsqqq/.config/syncthing"
      ];
      WorkingDirectory = "/Users/bdsqqq";
      RunAtLoad = true;
      KeepAlive = true;
      StandardOutPath = "/Users/bdsqqq/Library/Logs/syncthing.log";
      StandardErrorPath = "/Users/bdsqqq/Library/Logs/syncthing.log";
    };
  };
} else {}

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
  };
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

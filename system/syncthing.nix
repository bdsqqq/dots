{ lib, config, pkgs, ... }:
let
  inherit (lib) mkIf mkMerge;
  system = config.nixpkgs.hostPlatform.system or builtins.currentSystem;
  isLinux = lib.hasInfix "linux" system;
  isDarwin = lib.hasInfix "darwin" system;
in
mkMerge [
  (mkIf isLinux {
    services.syncthing = {
      enable = true;
      user = "bdsqqq";
      dataDir = "/home/bdsqqq";
      configDir = "/home/bdsqqq/.config/syncthing";
    };
  })
  (mkIf isDarwin {
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
  })
]

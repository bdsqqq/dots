{ lib, pkgs, ... }:
let
  cfg = {
    linux = lib.optionalAttrs pkgs.stdenv.isLinux {
      services.syncthing = {
        enable = true;
        user = "bdsqqq";
        dataDir = "/home/bdsqqq";
        configDir = "/home/bdsqqq/.config/syncthing";
      };
    };
    
    darwin = lib.optionalAttrs pkgs.stdenv.isDarwin {
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
    };
  };
in
cfg.linux // cfg.darwin

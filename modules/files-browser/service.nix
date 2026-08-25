{ config, lib, pkgs, ... }:
let
  cfg = config.my.filesBrowser;
  server = import ./package.nix { inherit pkgs; };
in
{
  options.my.filesBrowser = {
    source = lib.mkOption {
      type = lib.types.str;
      description = "directory exposed by the files browser";
    };
    state = lib.mkOption {
      type = lib.types.str;
      description = "runtime state directory for the files browser";
    };
    syncthingConfig = lib.mkOption {
      type = lib.types.str;
      description = "Syncthing configuration used for folder metadata";
    };
  };

  config = {
    my.tailnetRegistry.providers.files = {
      target = "http://127.0.0.1:3925";
      scheme = "https";
      port = 3925;
      healthPath = "/";
    };

    home-manager.users.bdsqqq = { config, lib, ... }: {
      home.packages = [ server ];
      home.activation.filesBrowserState = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        mkdir -p ${lib.escapeShellArg cfg.state}
      '';

      launchd.agents.files-browser = {
        enable = true;
        config = {
          ProgramArguments = [
            "${server}/bin/files-browser-server"
            "--source"
            cfg.source
            "--state"
            cfg.state
            "--syncthing-config"
            cfg.syncthingConfig
            "--syncthing-url"
            "http://127.0.0.1:8384"
            "--port"
            "3925"
          ];
          RunAtLoad = true;
          KeepAlive = true;
          ThrottleInterval = 10;
          ProcessType = "Background";
          StandardOutPath = "${config.home.homeDirectory}/Library/Logs/files-browser.log";
          StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/files-browser.log";
        };
      };
    };
  };
}

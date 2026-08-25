{ config, lib, pkgs, ... }:
let
  cfg = config.my.photoGallery;
  server = import ./package.nix { inherit pkgs; };
in
{
  options.my.photoGallery = {
    source = lib.mkOption {
      type = lib.types.str;
      description = "photo library exposed by the gallery";
    };
    state = lib.mkOption {
      type = lib.types.str;
      description = "runtime state directory for the gallery";
    };
  };

  config = {
    my.tailnetRegistry.providers.photos = {
      target = "http://127.0.0.1:3923";
      scheme = "https";
      port = 3923;
      path = "/gallery/";
      healthPath = "/gallery/";
      adoptExisting = true;
    };

    home-manager.users.bdsqqq = { config, lib, ... }: {
      home.packages = [ server ];
      home.activation.photoGalleryState = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        mkdir -p ${lib.escapeShellArg cfg.state}
      '';

      launchd.agents.ssd-gallery = {
        enable = true;
        config = {
          ProgramArguments = [
            "${server}/bin/photo-gallery-server"
            "--source"
            cfg.source
            "--state"
            cfg.state
            "--port"
            "3923"
            "--intelligence-url"
            "http://127.0.0.1:3924"
          ];
          RunAtLoad = true;
          KeepAlive = true;
          ThrottleInterval = 10;
          ProcessType = "Background";
          StandardOutPath = "${config.home.homeDirectory}/Library/Logs/ssd-gallery.log";
          StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/ssd-gallery.log";
        };
      };
    };
  };
}

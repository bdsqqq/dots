{
  config,
  pkgs,
  lib,
  ...
}:
let
  root = config.my.htmlStuff.root;
  server = import ./package.nix { inherit pkgs; };
in
{
  options.my.htmlStuff.root = lib.mkOption {
    type = lib.types.str;
    default = "${config.my.paths.commonplace}/01_files/html_stuff";
    description = "Directory containing HTML artifacts.";
  };

  config = {
    my.tailnetRegistry.providers.html-stuff = {
      target = "http://127.0.0.1:8766";
      scheme = "http";
      port = 8765;
      healthPath = "/";
      adoptExisting = true;
    };

    home-manager.users.bdsqqq = { config, lib, ... }: {
      home.packages = [ server ];

      home.activation.htmlStuffDirectory = lib.hm.dag.entryAfter [ "commonplaceScaffold" ] ''
        mkdir -p ${lib.escapeShellArg root}
      '';

      launchd.agents.html-stuff = {
        enable = true;
        config = {
          ProgramArguments = [
            "${server}/bin/html-stuff-server"
            "--directory"
            root
            "--port"
            "8766"
          ];
          RunAtLoad = true;
          KeepAlive = true;
          ThrottleInterval = 10;
          ProcessType = "Background";
          StandardOutPath = "${config.home.homeDirectory}/Library/Logs/html-stuff.log";
          StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/html-stuff.log";
        };
      };
    };
  };
}

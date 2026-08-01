{ config, pkgs, ... }:
let
  commonplace = config.my.paths.commonplace;
  root = "${commonplace}/01_files/html_stuff";
  source = pkgs.writeText "html-stuff-server.py" (builtins.readFile ./server.py);
  server = pkgs.writeShellApplication {
    name = "html-stuff-server";
    runtimeInputs = [
      pkgs.python3
      pkgs.tailscale
    ];
    text = ''
      exec python3 ${source} "$@"
    '';
  };
in {
  home-manager.users.bdsqqq = { config, lib, ... }: {
    home.packages = [ server ];

    home.activation.htmlStuffDirectory =
      lib.hm.dag.entryAfter [ "commonplaceScaffold" ] ''
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
          "8765"
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
}

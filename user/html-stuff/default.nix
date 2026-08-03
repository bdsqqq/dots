{ config, pkgs, ... }:
let
  commonplace = config.my.paths.commonplace;
  root = "${commonplace}/01_files/html_stuff";
  source = pkgs.writeText "html-stuff-server.ts" (builtins.readFile ./server.ts);
  server = pkgs.writeShellApplication {
    name = "html-stuff-server";
    runtimeInputs = [
      pkgs.bun
      pkgs.tailscale
    ];
    text = ''
      bun_pid=""
      cleanup() {
        tailscale serve --http=8765 off >/dev/null 2>&1 || true
        if [[ -n "$bun_pid" ]] && kill -0 "$bun_pid" 2>/dev/null; then
          kill "$bun_pid"
          wait "$bun_pid" 2>/dev/null || true
        fi
      }
      trap cleanup EXIT
      trap 'exit 143' TERM
      trap 'exit 130' INT

      bun run ${source} "$@" &
      bun_pid=$!
      tailscale serve --bg --yes --http=8765 http://127.0.0.1:8766
      wait "$bun_pid"
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
}

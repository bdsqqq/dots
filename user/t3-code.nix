{ lib, hostSystem ? null, ... }:
let
  isDarwin = hostSystem != null && lib.hasInfix "darwin" hostSystem;
in
{
  home-manager.users.bdsqqq = { config, pkgs, lib, ... }:
    let
      pnpmHome = config.home.sessionVariables.PNPM_HOME;
      pnpmGlobalBin = "${pnpmHome}/global/5/node_modules/.bin";
      t3CodeServe = pkgs.writeShellApplication {
        name = "t3-code-serve";
        runtimeInputs = with pkgs; [
          coreutils
          git
          nodejs
          openssh
          pnpm
        ];
        text = ''
          set -euo pipefail

          export PNPM_HOME="${pnpmHome}"
          export T3CODE_HOME="${config.home.homeDirectory}/.t3"
          export T3CODE_NO_BROWSER=true
          export PATH="${pnpmHome}:${pnpmGlobalBin}:/opt/homebrew/bin:/usr/local/bin:$PATH"

          for _ in $(seq 1 60); do
            if command -v t3 >/dev/null 2>&1; then
              break
            fi
            sleep 1
          done

          if ! command -v t3 >/dev/null 2>&1; then
            echo "t3-code-serve: t3 command not found; run home-manager activation first" >&2
            exit 127
          fi

          exec t3 serve \
            --host 127.0.0.1 \
            --port 3773 \
            --tailscale-serve \
            --tailscale-serve-port 443 \
            "${config.home.homeDirectory}"
        '';
      };
    in
    {
      home.packages = [ t3CodeServe ];

      launchd.agents.t3-code = lib.mkIf isDarwin {
        enable = true;
        config = {
          ProgramArguments = [ "${t3CodeServe}/bin/t3-code-serve" ];
          RunAtLoad = true;
          KeepAlive = { SuccessfulExit = false; };
          ProcessType = "Background";
          StandardOutPath = "${config.home.homeDirectory}/Library/Logs/t3-code.log";
          StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/t3-code.log";
        };
      };
    };
}

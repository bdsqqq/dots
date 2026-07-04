{ lib, hostSystem ? null, ... }:
let
  isDarwin = hostSystem != null && lib.hasInfix "darwin" hostSystem;
  isLinux = hostSystem != null && lib.hasInfix "linux" hostSystem;
in
{
  home-manager.users.bdsqqq = { config, pkgs, lib, ... }:
    let
      pnpmHome = config.home.sessionVariables.PNPM_HOME;
      pnpmGlobalBin = "${pnpmHome}/global/5/node_modules/.bin";
      t3Bin = "${pnpmGlobalBin}/t3";
      t3CodeServe = pkgs.writeShellApplication {
        name = "t3-code-serve";
        runtimeInputs = with pkgs; [
          coreutils
          git
          gnused
          nodejs
          openssh
          pnpm
        ] ++ lib.optionals isLinux [ tailscale ];
        text = ''
          set -euo pipefail

          export PNPM_HOME="${pnpmHome}"
          export T3CODE_HOME="${config.home.homeDirectory}/.t3"
          export T3CODE_NO_BROWSER=true
          export PATH="${pnpmGlobalBin}:${pnpmHome}:/opt/homebrew/bin:/usr/local/bin:$PATH"

          for _ in $(seq 1 60); do
            if [ -x "${t3Bin}" ]; then
              break
            fi
            sleep 1
          done

          if [ ! -x "${t3Bin}" ]; then
            echo "t3-code-serve: ${t3Bin} not found; run home-manager activation first" >&2
            exit 127
          fi

          runtimeStatePath="$T3CODE_HOME/userdata/server-runtime.json"
          mkdir -p "$(dirname "$runtimeStatePath")"

          childPid=""
          runtimeStatePid=""
          cleanup() {
            exitStatus=$?
            trap - EXIT INT TERM

            if [ -n "$childPid" ] && kill -0 "$childPid" 2>/dev/null; then
              kill "$childPid" 2>/dev/null || true
              wait "$childPid" 2>/dev/null || true
            fi

            if [ -n "$runtimeStatePid" ] && [ -f "$runtimeStatePath" ]; then
              currentRuntimePid="$(sed -n 's/.*"pid":\([0-9][0-9]*\).*/\1/p' "$runtimeStatePath")"
              if [ "$currentRuntimePid" = "$runtimeStatePid" ]; then
                rm -f "$runtimeStatePath"
              fi
            fi

            exit "$exitStatus"
          }
          trap cleanup EXIT INT TERM

          "${t3Bin}" serve \
            --host 127.0.0.1 \
            --port 3773 \
            --base-dir "$T3CODE_HOME" \
            --tailscale-serve \
            --tailscale-serve-port 443 \
            "${config.home.homeDirectory}" &

          childPid="$!"
          runtimeStatePid="$childPid"
          startedAt="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
          runtimeStateTmp="$runtimeStatePath.tmp.$$"
          printf '{"version":1,"pid":%s,"host":"127.0.0.1","port":3773,"origin":"http://127.0.0.1:3773","startedAt":"%s"}\n' "$runtimeStatePid" "$startedAt" > "$runtimeStateTmp"
          mv "$runtimeStateTmp" "$runtimeStatePath"

          wait "$childPid"
        '';
      };
    in
    {
      home.packages = [ t3CodeServe ];
    }
    // lib.optionalAttrs isLinux {
      systemd.user.services.t3-code = {
        Unit.Description = "T3 Code daemon";
        Service = {
          ExecStart = "${t3CodeServe}/bin/t3-code-serve";
          Restart = "on-failure";
          RestartSec = "10s";
          WorkingDirectory = config.home.homeDirectory;
        };
        Install.WantedBy = [ "default.target" ];
      };
    }
    // lib.optionalAttrs isDarwin {
      launchd.agents.t3-code = {
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
  // lib.optionalAttrs isLinux {
  users.users.bdsqqq.linger = true;
}

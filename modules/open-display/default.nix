{ config, lib, pkgs, ... }:

let
  cfg = config.my.openDisplay;
  preferenceDomain = "com.peetzweg.opensidecar.mac";

  openDisplayApp = pkgs.stdenvNoCC.mkDerivation {
    pname = "open-display";
    version = "1.17.0";
    src = pkgs.fetchurl {
      url = "https://github.com/peetzweg/opendisplay/releases/download/v1.17.0/OpenDisplay.dmg";
      hash = "sha256-CtTEr0FJXv8XjIEh70XGbMRc+8YmXoJ6NACNBUYqb0Q=";
    };
    nativeBuildInputs = [ pkgs._7zz ];
    sourceRoot = ".";
    unpackPhase = ''
      7zz x -y "$src"
    '';
    installPhase = ''
      runHook preInstall
      mkdir -p "$out/Applications"
      cp -R OpenDisplay.app "$out/Applications/"
      runHook postInstall
    '';
    # TCC grants are keyed to the upstream signature. Re-signing during Nix
    # fixup would make Screen Recording approval generation-dependent.
    dontFixup = true;
  };

  openDisplayAppPath = "${openDisplayApp}/Applications/OpenDisplay.app";
  openDisplayControl = pkgs.writeShellApplication {
    name = "open-display";
    text = ''
      set -euo pipefail

      app=${lib.escapeShellArg openDisplayAppPath}

      start_app() {
        /usr/bin/open -gja "$app" --args -mode extend -autostart YES
      }

      case "''${1:-}" in
        start)
          start_app
          ;;
        restart)
          /usr/bin/killall OpenDisplay >/dev/null 2>&1 || true
          for _ in {1..30}; do
            if ! /usr/bin/pgrep -x OpenDisplay >/dev/null; then
              start_app
              exit 0
            fi
            /bin/sleep 1
          done
          echo "OpenDisplay did not stop" >&2
          exit 1
          ;;
        stop)
          /usr/bin/killall OpenDisplay >/dev/null 2>&1 || true
          ;;
        status)
          /usr/bin/pgrep -x OpenDisplay
          ;;
        *)
          echo "usage: open-display {start|restart|stop|status}" >&2
          exit 1
          ;;
      esac
    '';
  };
in
{
  options.my.openDisplay.wifiServiceName = lib.mkOption {
    type = lib.types.str;
    default = "OpenDisplay";
    description = "Bonjour service name advertised by the OpenDisplay iPad app.";
  };

  config = {
    home-manager.users.bdsqqq = { lib, ... }: {
      home.packages = [ openDisplayApp openDisplayControl ];

      # OpenDisplay only auto-connects remembered Wi-Fi receivers during its
      # launch window. Seed that stable intent and restart only when managed
      # state changes so the detached LaunchServices process observes it.
      home.activation.openDisplayPreferences =
        lib.hm.dag.entryAfter [ "writeBoundary" ] ''
          changed=false
          receiver=${lib.escapeShellArg "wifi:${cfg.wifiServiceName}"}
          package=${lib.escapeShellArg openDisplayAppPath}

          if [ "$(/usr/bin/defaults read ${preferenceDomain} autostart 2>/dev/null || true)" != 1 ]; then
            /usr/bin/defaults write ${preferenceDomain} autostart -bool true
            changed=true
          fi
          if [ "$(/usr/bin/defaults read ${preferenceDomain} mode 2>/dev/null || true)" != extend ]; then
            /usr/bin/defaults write ${preferenceDomain} mode -string extend
            changed=true
          fi

          remembered_json=$(
            /usr/bin/defaults export ${preferenceDomain} - 2>/dev/null \
              | /usr/bin/plutil -extract wifiRemembered json -o - - 2>/dev/null \
              || printf '[]'
          )
          if ! printf '%s' "$remembered_json" \
            | ${pkgs.jq}/bin/jq --exit-status --arg receiver "$receiver" \
              'index($receiver) != null' >/dev/null; then
            if /usr/bin/defaults read ${preferenceDomain} wifiRemembered >/dev/null 2>&1; then
              /usr/bin/defaults write ${preferenceDomain} wifiRemembered -array-add "$receiver"
            else
              /usr/bin/defaults write ${preferenceDomain} wifiRemembered -array "$receiver"
            fi
            changed=true
          fi

          if [ "$(/usr/bin/defaults read ${preferenceDomain} nixManagedPackage 2>/dev/null || true)" != "$package" ]; then
            /usr/bin/defaults write ${preferenceDomain} nixManagedPackage -string "$package"
            changed=true
          fi

          if [ "$changed" = true ]; then
            ${openDisplayControl}/bin/open-display restart
          fi
        '';
    };

    launchd.user.agents.open-display.serviceConfig = {
      Label = "dev.open-display";
      ProgramArguments = [ "${openDisplayControl}/bin/open-display" "start" ];
      RunAtLoad = true;
      LimitLoadToSessionType = "Aqua";
      ProcessType = "Interactive";
      ThrottleInterval = 30;
      StandardOutPath = "/Users/bdsqqq/Library/Logs/open-display.log";
      StandardErrorPath = "/Users/bdsqqq/Library/Logs/open-display.log";
    };
  };
}

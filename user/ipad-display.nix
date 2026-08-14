{ lib, pkgs, ... }:

let
  betterDisplay = "/Applications/BetterDisplay.app/Contents/MacOS/BetterDisplay";
  virtualDisplayName = "iPad mini virtual";

  ipadDisplay = pkgs.writeShellApplication {
    name = "ipad-display";
    runtimeInputs = [ pkgs.coreutils ];
    text = ''
      set -euo pipefail

      better_display=${lib.escapeShellArg betterDisplay}
      virtual_display_name=${lib.escapeShellArg virtualDisplayName}
      config_dir="''${XDG_CONFIG_HOME:-$HOME/.config}/ipad-display"
      specifier_file="$config_dir/sidecar-specifier"

      usage() {
        cat <<'EOF'
      ipad-display setup
      ipad-display devices
      ipad-display select <Sidecar name or UUID>
      ipad-display connect
      ipad-display disconnect
      ipad-display status

      Run setup once after granting BetterDisplay its requested permissions.
      Use devices and select once before connecting from Raycast.
      EOF
      }

      require_better_display() {
        if [[ ! -x "$better_display" ]]; then
          echo "BetterDisplay is not installed yet" >&2
          exit 1
        fi
      }

      start_better_display() {
        require_better_display
        /usr/bin/open -gja /Applications/BetterDisplay.app

        for _ in $(seq 1 30); do
          if "$better_display" get -proAvailable >/dev/null 2>&1; then
            return 0
          fi
          sleep 1
        done

        echo "BetterDisplay did not become ready" >&2
        exit 1
      }

      restore_virtual_display() {
        "$better_display" set \
          -type=VirtualScreen \
          -name="$virtual_display_name" \
          -connected=on \
          -resolution=2266x1488 \
          -hiDPI=on \
          -main=on >/dev/null 2>&1 || true
      }

      setup_virtual_display() {
        local identifiers
        identifiers=$("$better_display" get -type=VirtualScreen -identifiers 2>/dev/null || true)

        if [[ "$identifiers" != *"$virtual_display_name"* ]]; then
          "$better_display" create \
            -type=VirtualScreen \
            -virtualScreenName="$virtual_display_name" \
            -useResolutionList=on \
            -resolutionList=2266x1488 \
            -virtualScreenHiDPI=on
        fi

        "$better_display" set \
          -type=VirtualScreen \
          -name="$virtual_display_name" \
          -connected=on \
          -resolution=2266x1488 \
          -hiDPI=on \
          -main=on
      }

      read_specifier() {
        if [[ ! -s "$specifier_file" ]]; then
          echo "No iPad selected. Run: ipad-display devices" >&2
          echo "Then run: ipad-display select <Sidecar name or UUID>" >&2
          exit 1
        fi
        head -n 1 "$specifier_file"
      }

      mirror_to_sidecar() {
        local specifier=$1
        local target_parameter

        if [[ "$specifier" =~ ^[[:xdigit:]]{8}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{12}$ ]]; then
          target_parameter="-targetUUID=$specifier"
        else
          target_parameter="-targetName=$specifier"
        fi

        for _ in $(seq 1 10); do
          if "$better_display" set \
            -name="$virtual_display_name" \
            -mirror=on \
            "$target_parameter" >/dev/null 2>&1; then
            return 0
          fi
          sleep 1
        done

        return 1
      }

      command=''${1:-}
      case "$command" in
        setup)
          start_better_display
          setup_virtual_display
          ;;
        restore)
          start_better_display
          restore_virtual_display
          ;;
        devices)
          start_better_display
          "$better_display" get -sidecarList
          ;;
        select)
          if [[ $# -ne 2 || -z "$2" ]]; then
            echo "usage: ipad-display select <Sidecar name or UUID>" >&2
            exit 1
          fi
          mkdir -p "$config_dir"
          printf '%s\n' "$2" > "$specifier_file"
          chmod 600 "$specifier_file"
          echo "Selected Sidecar device: $2"
          ;;
        connect)
          start_better_display
          restore_virtual_display
          specifier=$(read_specifier)
          last_error=""
          for _ in $(seq 1 3); do
            if output=$("$better_display" set -sidecarConnected=on -specifier="$specifier" 2>&1); then
              if mirror_to_sidecar "$specifier"; then
                echo "Connected iPad display: $specifier"
                exit 0
              fi
              echo "Sidecar connected, but the virtual display could not be mirrored to it." >&2
              echo "Check the BetterDisplay Pro license and display names." >&2
              exit 1
            fi
            last_error=$output
            sleep 2
          done
          printf '%s\n' "$last_error" >&2
          echo "Could not connect Sidecar. Wake and unlock the iPad, then retry." >&2
          exit 1
          ;;
        disconnect)
          start_better_display
          specifier=$(read_specifier)
          "$better_display" set -sidecarConnected=off -specifier="$specifier"
          echo "Disconnected Sidecar: $specifier"
          ;;
        status)
          start_better_display
          specifier=$(read_specifier)
          "$better_display" get -sidecarConnected -specifier="$specifier"
          ;;
        help|-h|--help)
          usage
          ;;
        *)
          usage >&2
          exit 1
          ;;
      esac
    '';
  };

  raycastCommand = pkgs.writeTextFile {
    name = "connect-ipad-display";
    executable = true;
    text = ''
      #!/bin/bash

      # Required parameters:
      # @raycast.schemaVersion 1
      # @raycast.title connect iPad display
      # @raycast.mode compact

      # Optional parameters:
      # @raycast.icon 🖥️
      # @raycast.packageName displays

      # Documentation:
      # @raycast.description Connect the selected iPad using Sidecar
      # @raycast.author bdsqqq

      exec ${ipadDisplay}/bin/ipad-display connect
    '';
  };
in
{
  homebrew.casks = [ "betterdisplay" ];

  # Automatic login still requires disabling FileVault and entering the account
  # password once in System Settings. Never store that password in Nix.
  system.defaults.loginwindow.autoLoginUser = "bdsqqq";

  power = {
    restartAfterPowerFailure = true;
    sleep = {
      computer = "never";
      display = "never";
    };
  };

  home-manager.users.bdsqqq = { config, ... }: {
    home.packages = [ ipadDisplay ];

    home.file.".config/raycast/script-commands/connect-ipad-display.sh".source = raycastCommand;

    launchd.agents.ipad-display = {
      enable = true;
      config = {
        ProgramArguments = [ "${ipadDisplay}/bin/ipad-display" "restore" ];
        RunAtLoad = true;
        ProcessType = "Interactive";
        ThrottleInterval = 30;
        StandardOutPath = "${config.home.homeDirectory}/Library/Logs/ipad-display.log";
        StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/ipad-display.log";
      };
    };
  };
}

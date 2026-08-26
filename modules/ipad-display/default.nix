{ config, lib, pkgs, ... }:

let
  cfg = config.my.ipadDisplay;
  betterDisplayApp = pkgs.stdenvNoCC.mkDerivation {
    pname = "betterdisplay";
    version = "5.0.2-pre-release";
    src = pkgs.fetchurl {
      url = "https://github.com/waydabber/BetterDisplay/releases/download/v5.0.2/BetterDisplay-v5.0.2-pre-release.dmg";
      hash = "sha256-fw79lBqWD4foVTqE9jMtu316pEsXqlANo7Rwywpfbyo=";
    };
    nativeBuildInputs = [ pkgs.undmg ];
    sourceRoot = ".";
    installPhase = ''
      runHook preInstall
      mkdir -p "$out/Applications"
      cp -R BetterDisplay.app "$out/Applications/"
      runHook postInstall
    '';
    # Preserve the upstream signature so macOS permissions remain associated
    # with BetterDisplay across Nix generations.
    dontFixup = true;
  };
  betterDisplayAppPath = "${betterDisplayApp}/Applications/BetterDisplay.app";
  betterDisplay = "${betterDisplayAppPath}/Contents/MacOS/BetterDisplay";
  virtualDisplayName = "iPad mini virtual";
  virtualDisplayResolution = "1512x992";

  ipadDisplay = pkgs.writeShellApplication {
    name = "ipad-display";
    runtimeInputs = [ pkgs.coreutils ];
    text = ''
      set -euo pipefail

      better_display_app=${lib.escapeShellArg betterDisplayAppPath}
      better_display=${lib.escapeShellArg betterDisplay}
      virtual_display_name=${lib.escapeShellArg virtualDisplayName}
      virtual_display_resolution=${lib.escapeShellArg virtualDisplayResolution}
      physical_display_name=${lib.escapeShellArg (
        if cfg.physicalDisplayName == null then "" else cfg.physicalDisplayName
      )}
      main_display_name=${lib.escapeShellArg (
        if cfg.mainDisplayName == null then "" else cfg.mainDisplayName
      )}
      sidecar_specifier=${lib.escapeShellArg cfg.sidecarSpecifier}

      usage() {
        cat <<'EOF'
      ipad-display setup
      ipad-display devices
      ipad-display connect
      ipad-display disconnect
      ipad-display status

      setup reapplies the virtual display configuration declared in Nix.
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
        /usr/bin/open -gja "$better_display_app"

        for _ in $(seq 1 30); do
          if "$better_display" get -proAvailable >/dev/null 2>&1; then
            return 0
          fi
          sleep 1
        done

        echo "BetterDisplay did not become ready" >&2
        exit 1
      }

      configure_virtual_display() {
        "$better_display" set \
          -type=VirtualScreen \
          -name="$virtual_display_name" \
          -useResolutionList=on \
          -resolutionList="$virtual_display_resolution" \
          || return 1

        "$better_display" set \
          -type=VirtualScreen \
          -name="$virtual_display_name" \
          -connected=on \
          -resolution="$virtual_display_resolution" \
          -hiDPI=on \
          || return 1

        if [[ -n "$main_display_name" ]]; then
          local main_display_configured=false
          for _ in $(seq 1 10); do
            if "$better_display" set -name="$main_display_name" -main=on; then
              main_display_configured=true
              break
            fi
            sleep 1
          done
          [[ "$main_display_configured" == true ]] || return 1
        fi

        if [[ -n "$physical_display_name" ]] \
          && "$better_display" get -name="$physical_display_name" -identifier >/dev/null 2>&1; then
          "$better_display" set \
            -name="$virtual_display_name" \
            -mirror=on \
            -targetName="$physical_display_name" \
            || return 1
        fi
      }

      restore_virtual_display() {
        for _ in $(seq 1 5); do
          if setup_virtual_display; then
            return 0
          fi
          sleep 5
        done

        echo "Could not restore the declared virtual display configuration." >&2
        return 1
      }

      setup_virtual_display() {
        local identifiers
        identifiers=$("$better_display" get -type=VirtualScreen -identifiers 2>/dev/null || true)

        if [[ "$identifiers" != *"$virtual_display_name"* ]]; then
          "$better_display" create \
            -type=VirtualScreen \
            -virtualScreenName="$virtual_display_name" \
            -useResolutionList=on \
            -resolutionList="$virtual_display_resolution" \
            -virtualScreenHiDPI=on \
            || return 1
        fi

        configure_virtual_display
      }

      read_specifier() {
        printf '%s\n' "$sidecar_specifier"
      }

      mirror_to_sidecar() {
        local specifier=$1
        local target_parameters=()

        if [[ "$specifier" =~ ^[[:xdigit:]]{8}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{12}$ ]]; then
          local sidecar_entry
          local sidecar_name=""
          while IFS= read -r sidecar_entry; do
            if [[ "$sidecar_entry" == *", $specifier" ]]; then
              sidecar_name="''${sidecar_entry%, "$specifier"}"
              break
            fi
          done < <("$better_display" get -sidecarList)

          if [[ -z "$sidecar_name" ]]; then
            return 1
          fi
          target_parameters+=("-targetName=$sidecar_name")
        else
          target_parameters+=("-targetName=$specifier")
        fi

        if [[ -n "$physical_display_name" ]] \
          && "$better_display" get -name="$physical_display_name" -identifier >/dev/null 2>&1; then
          target_parameters+=("-targetName=$physical_display_name")
        fi

        for _ in $(seq 1 10); do
          if "$better_display" set \
            -name="$virtual_display_name" \
            -mirror=on \
            "''${target_parameters[@]}" >/dev/null 2>&1; then
            return 0
          fi
          sleep 1
        done

        return 1
      }

      command=''${1:-}

      # Raycast sends repeated key-down events while a shortcut is held. Display
      # mutations must be serialized because concurrent BetterDisplay clients can
      # race while replacing the same virtual display.
      lock_file="''${TMPDIR:-/tmp}/ipad-display-$UID.lock"
      if ! /usr/bin/shlock -f "$lock_file" -p "$$"; then
        if [[ "$command" == restore ]]; then
          echo "An iPad display operation blocked startup restoration." >&2
          exit 1
        fi
        echo "An iPad display operation is already in progress."
        exit 0
      fi
      trap 'rm -f "$lock_file"' EXIT

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
        connect)
          start_better_display
          specifier=$(read_specifier)
          last_error=""

          if [[ $("$better_display" get -sidecarConnected -specifier="$specifier" 2>/dev/null) == "on" ]]; then
            if mirror_to_sidecar "$specifier"; then
              echo "Connected iPad display: $specifier"
              exit 0
            fi
            echo "Sidecar is connected, but the virtual display could not be mirrored to it." >&2
            exit 1
          fi

          for _ in $(seq 1 5); do
            if ! output=$("$better_display" set -sidecarConnected=on -specifier="$specifier" 2>&1); then
              last_error=$output
            fi

            sleep 2

            if [[ $("$better_display" get -sidecarConnected -specifier="$specifier" 2>/dev/null) == "on" ]] \
              && mirror_to_sidecar "$specifier"; then
              echo "Connected iPad display: $specifier"
              exit 0
            fi
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

in
{
  options.my.ipadDisplay = {
    mainDisplayName = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Optional BetterDisplay display name to enforce as the macOS main display.";
    };

    physicalDisplayName = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Optional physical display mirrored alongside the selected Sidecar device.";
    };

    sidecarSpecifier = lib.mkOption {
      type = lib.types.str;
      description = "BetterDisplay Sidecar name or UUID selected by connect and disconnect.";
    };
  };

  config = {
    home-manager.users.bdsqqq = { ... }: {
      home.packages = [ betterDisplayApp ipadDisplay ];

      home.file.".local/bin/ipad-display" = {
        source = "${ipadDisplay}/bin/ipad-display";
        force = true;
      };

    };

    launchd.user.agents.ipad-display.serviceConfig = {
      Label = "dev.ipad-display";
      ProgramArguments = [ "${ipadDisplay}/bin/ipad-display" "restore" ];
      RunAtLoad = true;
      ProcessType = "Interactive";
      ThrottleInterval = 30;
      StandardOutPath = "/Users/bdsqqq/Library/Logs/ipad-display.log";
      StandardErrorPath = "/Users/bdsqqq/Library/Logs/ipad-display.log";
    };
  };
}

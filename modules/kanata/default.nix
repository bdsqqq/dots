{ lib, pkgs, hostSystem ? null, ... }:

let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  isLinux = lib.hasInfix "linux" hostSystem;

  # shared with launchd configs below
  kanataLabel = "com.bdsqqq.kanata";
  virtualhidLabel = "com.bdsqqq.karabiner-virtualhid-daemon";
  kanataPlist = "/Library/LaunchDaemons/${kanataLabel}.plist";
  virtualhidPlist = "/Library/LaunchDaemons/${virtualhidLabel}.plist";
  virtualhidDaemon = "/Library/Application Support/org.pqrs/Karabiner-DriverKit-VirtualHIDDevice/Applications/Karabiner-VirtualHIDDevice-Daemon.app/Contents/MacOS/Karabiner-VirtualHIDDevice-Daemon";
  # TCC resolves symlinks, so Kanata and its non-system libraries must be real
  # files at stable paths rather than references into a garbage-collected store
  # generation. A package update changes Kanata's signature and may still require
  # macOS or MDM to renew Input Monitoring and Accessibility approval.
  kanataStablePath = "/usr/local/bin/kanata";
  kanataStableLibDir = "/usr/local/lib/kanata";
  kanataLibiconv = "${pkgs.libiconv}/lib/libiconv.2.dylib";
  kanataLibcharset = "${pkgs.libiconv}/lib/libcharset.1.dylib";

  toggleKanata = pkgs.writeShellScriptBin "toggle-kanata" ''
    set -euo pipefail

    usage() {
        cat <<EOF
    toggle-kanata [start|stop|toggle|status] [-v] [-n]
    EOF
    }

    VERBOSE=false
    DRY_RUN=false
    COMMAND="toggle"

    log() { [[ "$VERBOSE" = true ]] && echo "$@" >&2 || true; }

    ${if isDarwin then ''
      KANATA_LABEL="${kanataLabel}"
      VIRTUALHID_LABEL="${virtualhidLabel}"
      KANATA_PLIST="${kanataPlist}"
      VIRTUALHID_PLIST="${virtualhidPlist}"

      is_kanata_running() { pgrep -x kanata > /dev/null 2>&1; }
      get_status() { is_kanata_running && echo "●" || echo "○"; }

      start_kanata() {
          log "starting launchd services..."
          if [[ "$DRY_RUN" = true ]]; then
              echo "[dry-run] would bootstrap $VIRTUALHID_PLIST"
              echo "[dry-run] would bootstrap $KANATA_PLIST"
              return 0
          fi
          [[ -f "$VIRTUALHID_PLIST" ]] && sudo launchctl bootstrap system "$VIRTUALHID_PLIST" 2>/dev/null || log "virtualhid already loaded"
          if [[ -f "$KANATA_PLIST" ]]; then
              sudo launchctl bootstrap system "$KANATA_PLIST" 2>/dev/null || log "kanata already loaded"
          else
              echo "✗ $KANATA_PLIST not found" >&2; exit 1
          fi
      }

      stop_kanata() {
          log "stopping launchd services..."
          if [[ "$DRY_RUN" = true ]]; then
              echo "[dry-run] would bootout $KANATA_LABEL"
              echo "[dry-run] would bootout $VIRTUALHID_LABEL"
              return 0
          fi
          sudo launchctl bootout system/$KANATA_LABEL 2>/dev/null || log "kanata not loaded"
          sudo launchctl bootout system/$VIRTUALHID_LABEL 2>/dev/null || log "virtualhid not loaded"
          is_kanata_running && { log "fallback kill..."; sudo killall kanata Karabiner-VirtualHIDDevice-Daemon 2>/dev/null || true; }
      }
    '' else ''
      is_kanata_running() { pgrep -x kanata > /dev/null 2>&1; }
      get_status() { is_kanata_running && echo "●" || echo "○"; }

      start_kanata() {
          log "starting systemd service..."
          if [[ "$DRY_RUN" = true ]]; then echo "[dry-run] would start kanata.service"; return 0; fi
          systemctl --user is-enabled kanata.service > /dev/null 2>&1 && systemctl --user start kanata.service || { echo "✗ kanata.service not found" >&2; exit 1; }
      }

      stop_kanata() {
          log "stopping systemd service..."
          if [[ "$DRY_RUN" = true ]]; then echo "[dry-run] would stop kanata.service"; return 0; fi
          systemctl --user is-active kanata.service > /dev/null 2>&1 && systemctl --user stop kanata.service || pkill kanata 2>/dev/null || true
      }
    ''}

    positional=()
    while [[ $# -gt 0 ]]; do
        case "$1" in
            -h|--help) usage; exit 0 ;;
            -v|--verbose) VERBOSE=true; shift ;;
            -n|--dry-run) DRY_RUN=true; shift ;;
            -*) echo "unknown option: $1" >&2; usage >&2; exit 1 ;;
            *) positional+=("$1"); shift ;;
        esac
    done
    [[ ''${#positional[@]} -ge 1 ]] && COMMAND="''${positional[0]}"

    case "$COMMAND" in
        status) get_status ;;
        on|start|enable)
            is_kanata_running && echo "● kanata already running" || {
                start_kanata
                [[ "$DRY_RUN" = true ]] && exit 0
                sleep 3
                is_kanata_running && echo "✓ kanata started" || { echo "✗ failed to start" >&2; exit 1; }
            } ;;
        off|stop|disable)
            is_kanata_running && {
                stop_kanata
                [[ "$DRY_RUN" = true ]] && exit 0
                sleep 2
                is_kanata_running && { echo "✗ failed to stop" >&2; exit 1; } || echo "✓ kanata stopped"
            } || echo "○ kanata already stopped" ;;
        toggle|*)
            if is_kanata_running; then
                stop_kanata; [[ "$DRY_RUN" = true ]] && exit 0; sleep 2
                is_kanata_running && { echo "✗ failed to stop" >&2; exit 1; } || echo "✓ kanata stopped"
            else
                start_kanata; [[ "$DRY_RUN" = true ]] && exit 0; sleep 3
                is_kanata_running && echo "✓ kanata started" || { echo "✗ failed to start" >&2; exit 1; }
            fi ;;
    esac
  '';
in
if isDarwin then {
  environment.systemPackages = [
    toggleKanata
    # 60s timeout prevents keyboard lockout if config is broken
    (pkgs.writeShellScriptBin "kanata-test" ''
      echo "kanata test mode (60s timeout) - press enter to start"
      read

      sudo "/Library/Application Support/org.pqrs/Karabiner-DriverKit-VirtualHIDDevice/Applications/Karabiner-VirtualHIDDevice-Daemon.app/Contents/MacOS/Karabiner-VirtualHIDDevice-Daemon" &
      DAEMON_PID=$!
      sleep 2

      sudo ${kanataStablePath} --cfg /etc/kanata/kanata.kbd &
      KANATA_PID=$!

      echo "test your keyboard now"
      for i in {60..1}; do
        [[ $((i % 10)) -eq 0 ]] && echo "$i"
        sleep 1
      done

      sudo kill $KANATA_PID $DAEMON_PID 2>/dev/null || true
      sudo killall kanata Karabiner-VirtualHIDDevice-Daemon 2>/dev/null || true

      echo "did it work? (y/n)"
      read response
      [[ "$response" =~ ^[Yy]$ ]] && echo "run: toggle-kanata start" || echo "check /var/log/kanata.log"
    '')
  ];

  environment.etc."kanata/kanata.kbd".source = ../../assets/kanata.kbd;

  system.activationScripts.extraActivation.text = ''
    if [ ! -x ${lib.escapeShellArg virtualhidDaemon} ]; then
      echo "warning: Karabiner VirtualHIDDevice daemon missing; install/activate it manually before starting kanata" >&2
    fi

    mkdir -p /usr/local/bin ${kanataStableLibDir}
    kanata_stage="$(mktemp -d /usr/local/.kanata-stage.XXXXXX)"
    cleanup_kanata_stage() { rm -rf "$kanata_stage"; }
    trap cleanup_kanata_stage EXIT
    mkdir -p "$kanata_stage/bin" "$kanata_stage/lib"

    install -m 0755 ${pkgs.kanata}/bin/kanata "$kanata_stage/bin/kanata"
    install -m 0644 ${kanataLibiconv} "$kanata_stage/lib/libiconv.2.dylib"
    install -m 0644 ${kanataLibcharset} "$kanata_stage/lib/libcharset.1.dylib"

    /usr/bin/install_name_tool \
      -change ${kanataLibiconv} @executable_path/../lib/kanata/libiconv.2.dylib \
      "$kanata_stage/bin/kanata"
    /usr/bin/install_name_tool \
      -id @loader_path/libcharset.1.dylib \
      "$kanata_stage/lib/libcharset.1.dylib"
    /usr/bin/install_name_tool \
      -id @loader_path/libiconv.2.dylib \
      -change ${kanataLibcharset} @loader_path/libcharset.1.dylib \
      "$kanata_stage/lib/libiconv.2.dylib"

    /usr/bin/codesign --force --sign - "$kanata_stage/lib/libcharset.1.dylib"
    /usr/bin/codesign --force --sign - "$kanata_stage/lib/libiconv.2.dylib"
    /usr/bin/codesign --force --sign - --identifier ${kanataLabel} "$kanata_stage/bin/kanata"

    if [ ! -x ${kanataStablePath} ] \
      || [ ! -f ${kanataStableLibDir}/libiconv.2.dylib ] \
      || [ ! -f ${kanataStableLibDir}/libcharset.1.dylib ] \
      || ! cmp -s "$kanata_stage/bin/kanata" ${kanataStablePath} \
      || ! cmp -s "$kanata_stage/lib/libiconv.2.dylib" ${kanataStableLibDir}/libiconv.2.dylib \
      || ! cmp -s "$kanata_stage/lib/libcharset.1.dylib" ${kanataStableLibDir}/libcharset.1.dylib; then
      mv -f "$kanata_stage/lib/libcharset.1.dylib" ${kanataStableLibDir}/libcharset.1.dylib
      mv -f "$kanata_stage/lib/libiconv.2.dylib" ${kanataStableLibDir}/libiconv.2.dylib
      mv -f "$kanata_stage/bin/kanata" ${kanataStablePath}
    fi
    cleanup_kanata_stage
    trap - EXIT
  '';

  launchd.daemons.karabiner-virtualhid-daemon = {
    serviceConfig = {
      Label = virtualhidLabel;
      ProgramArguments = [
        virtualhidDaemon
      ];
      RunAtLoad = true;
      KeepAlive = true;
      StandardOutPath = "/var/log/karabiner-virtualhid-daemon.log";
      StandardErrorPath = "/var/log/karabiner-virtualhid-daemon.log";
    };
  };

  # sleep 5 ensures virtualhid daemon is ready before kanata tries to use it
  launchd.daemons.kanata = {
    serviceConfig = {
      Label = kanataLabel;
      ProgramArguments = [
        "/bin/bash"
        "-c"
        "sleep 5 && ${kanataStablePath} --no-wait --cfg /etc/kanata/kanata.kbd"
      ];
      RunAtLoad = true;
      KeepAlive = true;
      StandardOutPath = "/var/log/kanata.log";
      StandardErrorPath = "/var/log/kanata.log";
    };
  };
} else if isLinux then {
  environment.systemPackages = [ pkgs.kanata toggleKanata ];
  environment.etc."kanata/kanata.kbd".source = ../../assets/kanata.kbd;
} else
  { }

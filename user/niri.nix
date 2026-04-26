{ pkgs, lib, config, inputs, hostSystem ? null, ... }:

let
  toggleTheme = import ./scripts/toggle-theme.nix { inherit pkgs; };

  # raw KDL bridge for niri 26.04 background effects. niri-flake still validates
  # the generated base config; activation validates this by making it the live config.
  niriBackgroundEffects = pkgs.writeText "niri-background-effects.kdl" ''

    blur {
        passes 3
        offset 3.0
        noise 0.02
        saturation 1.5
    }

    window-rule {
        background-effect {
            blur true
            xray true
        }

        popups {
            opacity 0.95
            geometry-corner-radius 8

            background-effect {
                blur true
                xray false
            }
        }
    }

    layer-rule {
        match namespace="quickshell-control-center"
        opacity 0.95

        background-effect {
            blur true
            xray false
        }
    }

    layer-rule {
        match namespace="quickshell-notifications"
        opacity 0.95

        background-effect {
            blur true
            xray false
        }
    }

  '';

  screenshotDir = "/home/bdsqqq/commonplace/01_files/_utilities/screenshots";

  cleanshot-niri = pkgs.writeShellScriptBin "cleanshot-niri" ''
    set -euo pipefail

    screenshot_dir="${screenshotDir}"
    state_dir="$HOME/.local/state/cleanshot-niri"
    geom_file="$state_dir/last-area"
    recorder_pid_file="$state_dir/recording.pid"
    recorder_file="$state_dir/recording.path"
    mkdir -p "$screenshot_dir" "$state_dir"

    sanitize() {
      ${pkgs.coreutils}/bin/printf '%s' "$1" \
        | ${pkgs.gnused}/bin/sed 's/[\/\\:*?"<>|]//g; s/[[:space:]]\+/ /g; s/^ //; s/ $//; s/^$/Screen/' \
        | ${pkgs.coreutils}/bin/cut -c 1-120
    }

    focused_label() {
      if window_json="$(${pkgs.niri}/bin/niri msg --json focused-window 2>/dev/null)"; then
        app="$(${pkgs.jq}/bin/jq -r '.app_id // "Screen"' <<<"$window_json")"
        title="$(${pkgs.jq}/bin/jq -r '.title // ""' <<<"$window_json")"
        app="$(sanitize "$app")"
        title="$(sanitize "$title")"
        if [ -n "$title" ] && [ "$title" != "Screen" ]; then
          ${pkgs.coreutils}/bin/printf '%s_%s' "$app" "$title"
        else
          ${pkgs.coreutils}/bin/printf '%s' "$app"
        fi
      else
        ${pkgs.coreutils}/bin/printf 'Screen'
      fi
    }

    output_path() {
      ext="$1"
      label="$(focused_label)"
      stamp="$(${pkgs.coreutils}/bin/date '+%Y-%m-%dT%H-%M-%S')"
      path="$screenshot_dir/$stamp $label -- source__screenshot.$ext"
      if [ ! -e "$path" ]; then
        ${pkgs.coreutils}/bin/printf '%s' "$path"
        return
      fi
      i=1
      while [ -e "''${path%.$ext}_$i.$ext" ]; do i=$((i + 1)); done
      ${pkgs.coreutils}/bin/printf '%s' "''${path%.$ext}_$i.$ext"
    }

    notify_capture() {
      file="$1"
      action="$(${pkgs.libnotify}/bin/notify-send \
        --app-name="CleanShot niri" \
        --icon="$file" \
        --action=copy="Copy" \
        --action=edit="Annotate" \
        --action=delete="Delete" \
        --action=open="Open Folder" \
        "Screenshot captured" "$(${pkgs.coreutils}/bin/basename "$file")" || true)"

      case "$action" in
        copy) ${pkgs.wl-clipboard}/bin/wl-copy < "$file" ;;
        edit)
          tmp="$state_dir/annotated.png"
          ${pkgs.satty}/bin/satty --filename "$file" --fullscreen --output-filename "$tmp" --copy-command "${pkgs.wl-clipboard}/bin/wl-copy" --actions-on-enter save-to-clipboard --actions-on-escape exit
          if [ -s "$tmp" ]; then
            ${pkgs.coreutils}/bin/mv "$tmp" "$file"
            ${pkgs.wl-clipboard}/bin/wl-copy < "$file"
          fi
          ;;
        delete) ${pkgs.coreutils}/bin/rm -f "$file" ;;
        open) ${pkgs.xdg-utils}/bin/xdg-open "$screenshot_dir" >/dev/null 2>&1 & ;;
      esac
    }

    notify_recording() {
      file="$1"
      action="$(${pkgs.libnotify}/bin/notify-send \
        --app-name="CleanShot niri" \
        --icon="$file" \
        --action=copy="Copy" \
        --action=save="Save" \
        --action=delete="Delete" \
        "Recording saved" "$(${pkgs.coreutils}/bin/basename "$file")" || true)"

      case "$action" in
        copy) ${pkgs.wl-clipboard}/bin/wl-copy --type video/mp4 < "$file" ;;
        save) ${pkgs.xdg-utils}/bin/xdg-open "$screenshot_dir" >/dev/null 2>&1 & ;;
        delete) ${pkgs.coreutils}/bin/rm -f "$file" ;;
      esac
    }

    capture_area() {
      geom="$1"
      file="$(output_path png)"
      ${pkgs.grim}/bin/grim -g "$geom" "$file"
      ${pkgs.wl-clipboard}/bin/wl-copy < "$file"
      notify_capture "$file"
    }

    case "''${1:-}" in
      area)
        geom="$(${pkgs.slurp}/bin/slurp)"
        [ -n "$geom" ]
        ${pkgs.coreutils}/bin/printf '%s' "$geom" > "$geom_file"
        capture_area "$geom"
        ;;
      repeat-area)
        [ -s "$geom_file" ] || geom="$(${pkgs.slurp}/bin/slurp)"
        geom="''${geom:-$(${pkgs.coreutils}/bin/cat "$geom_file")}"
        ${pkgs.coreutils}/bin/printf '%s' "$geom" > "$geom_file"
        capture_area "$geom"
        ;;
      window)
        before="$(${pkgs.coreutils}/bin/date +%s)"
        ${pkgs.niri}/bin/niri msg action screenshot-window show-pointer=true
        file="$(${pkgs.findutils}/bin/find "$screenshot_dir" -maxdepth 1 -type f -newermt "@$before" -name '*source__screenshot*' -printf '%T@ %p\n' | ${pkgs.coreutils}/bin/sort -nr | ${pkgs.coreutils}/bin/head -n1 | ${pkgs.coreutils}/bin/cut -d' ' -f2-)"
        [ -n "$file" ] && notify_capture "$file"
        ;;
      record)
        if [ -s "$recorder_pid_file" ] && ${pkgs.procps}/bin/kill -0 "$(${pkgs.coreutils}/bin/cat "$recorder_pid_file")" 2>/dev/null; then
          recorder_pid="$(${pkgs.coreutils}/bin/cat "$recorder_pid_file")"
          file="$(${pkgs.coreutils}/bin/cat "$recorder_file")"
          ${pkgs.procps}/bin/pkill -INT -P "$recorder_pid" 2>/dev/null || ${pkgs.procps}/bin/kill -INT "$recorder_pid"
          wait "$recorder_pid" 2>/dev/null || true
          ${pkgs.coreutils}/bin/rm -f "$recorder_pid_file" "$recorder_file"
          [ -s "$file" ] && notify_recording "$file"
          exit 0
        fi
        geom="$(${pkgs.slurp}/bin/slurp)"
        [ -n "$geom" ]
        ${pkgs.coreutils}/bin/printf '%s' "$geom" > "$geom_file"
        file="$(output_path mp4)"
        ${pkgs.wf-recorder}/bin/wf-recorder -g "$geom" -f "$file" &
        ${pkgs.coreutils}/bin/printf '%s' "$!" > "$recorder_pid_file"
        ${pkgs.coreutils}/bin/printf '%s' "$file" > "$recorder_file"
        ${pkgs.libnotify}/bin/notify-send --app-name="CleanShot niri" "Recording started" "Press Super+Shift+5 again to stop."
        ;;
      *)
        echo "usage: cleanshot-niri {window|area|repeat-area|record}" >&2
        exit 64
        ;;
    esac
  '';

  # touchscreen gesture daemon for niri (niri lacks native touchscreen swipe gestures)
  # uses lisgd to translate edge swipes to niri actions
  lisgd-niri = pkgs.writeShellScriptBin "lisgd-niri" ''
    # find touchscreen via udev ID_INPUT_TOUCHSCREEN property
    for dev in /dev/input/event*; do
      if ${pkgs.systemd}/bin/udevadm info "$dev" 2>/dev/null | grep -q "ID_INPUT_TOUCHSCREEN=1"; then
        TOUCH_DEV="$dev"
        break
      fi
    done
    if [ -z "$TOUCH_DEV" ]; then
      echo "lisgd-niri: no touchscreen device found" >&2
      exit 1
    fi

    # find niri socket
    NIRI_SOCK=$(ls /run/user/$(id -u)/niri.*.sock 2>/dev/null | head -1)
    export NIRI_SOCKET="$NIRI_SOCK"

    # 3-finger swipes anywhere on screen (natural scrolling style)
    # 1-finger edge swipes mirror phone navigation muscle memory
    # 1-finger top-right edge swipe down for control center
    # 1-finger top edge swipe down for bar toggle
    exec ${pkgs.lisgd}/bin/lisgd -d "$TOUCH_DEV" \
      -t 50 \
      -m 1500 \
      -g '1,UD,TR,*,R,${
        inputs.quickshell.packages.${hostSystem}.default
      }/bin/qs ipc call control-center toggleControlCenter' \
      -g '1,UD,T,*,R,${
        inputs.quickshell.packages.${hostSystem}.default
      }/bin/qs ipc call bar toggle' \
      -g '1,DU,L,*,R,niri msg action focus-window-or-workspace-down' \
      -g '1,UD,L,*,R,niri msg action focus-window-or-workspace-up' \
      -g '1,DU,R,*,R,niri msg action focus-window-or-workspace-down' \
      -g '1,UD,R,*,R,niri msg action focus-window-or-workspace-up' \
      -g '1,RL,B,*,R,niri msg action focus-column-right' \
      -g '1,LR,B,*,R,niri msg action focus-column-left' \
      -g '1,DU,B,*,R,niri msg action toggle-overview' \
      -g '3,DU,*,*,R,niri msg action move-window-down-or-to-workspace-up' \
      -g '3,UD,*,*,R,niri msg action move-window-up-or-to-workspace-down' \
      -g '3,RL,*,*,R,niri msg action move-column-left' \
      -g '3,LR,*,*,R,niri msg action move-column-right' \
  '';

in if !(lib.hasInfix "linux" hostSystem) then
  { }
else {
  programs.niri = {
    settings = {
      spawn-at-startup = [
        {
          argv = [
            "${pkgs.swaybg}/bin/swaybg"
            "-i"
            "/etc/wallpaper.jpg"
            "-m"
            "fill"
          ];
        }
        # quickshell and lisgd-niri run as systemd user services for auto-restart on config change
        {
          argv = [
            "${inputs.vicinae.packages.${hostSystem}.default}/bin/vicinae"
            "server"
          ];
        }
        { argv = [ "${pkgs.xwayland-satellite}/bin/xwayland-satellite" ":0" ]; }
      ];

      # Environment variables
      # note: GDK_SCALE/GDK_DPI_SCALE explicitly unset - niri handles fractional scaling natively
      # setting those would double-scale GTK apps including waybar
      environment = {
        XCURSOR_THEME = "macOS";
        XCURSOR_SIZE = "24";
        ELECTRON_OZONE_PLATFORM_HINT = "wayland";
        NIXOS_OZONE_WL = "1";
        QT_QPA_PLATFORM = "wayland";
        QT_AUTO_SCREEN_SCALE_FACTOR = "1";
        DISPLAY = ":0";
        GDK_SCALE = null;
        GDK_DPI_SCALE = null;
        # steam UI scaling (niri handles fractional scaling natively, steam needs this separately)
        STEAM_FORCE_DESKTOPUI_SCALING = "1.5";
      };

      input = {
        keyboard.xkb.layout = "us";
        mouse.accel-profile = "flat";
        touchpad = {
          tap = true;
          natural-scroll = true;
        };
      };

      # Output/monitor config
      # scale is auto-detected from EDID physical dimensions (since 0.1.6)
      # only add explicit output blocks if auto-detection doesn't work for your monitor

      cursor = {
        theme = "macOS";
        size = 24;
      };

      # Layout - niri's scrolling layout with gaps matching hyprland
      layout = {
        gaps = 8;

        border.enable = false;
        focus-ring.enable = false;

        default-column-width.proportion = 0.5;

        preset-column-widths = [
          { proportion = 1.0 / 3.0; }
          { proportion = 0.5; }
          { proportion = 2.0 / 3.0; }
          { proportion = 1.0; }
        ];
      };

      # Window decorations
      prefer-no-csd = true;
      screenshot-path = "${screenshotDir}/%Y-%m-%dT%H-%M-%S -- source__screenshot.png";

      window-rules = [{
        draw-border-with-background = false;
        opacity = 0.95;
        geometry-corner-radius = {
          top-left = 8.0;
          top-right = 8.0;
          bottom-right = 8.0;
          bottom-left = 8.0;
        };
        clip-to-geometry = true;
      }];

      layer-rules = [{
        # swaybg in backdrop so it doesn't move with workspaces
        matches = [{ namespace = "^wallpaper$"; }];
        place-within-backdrop = true;
      }];

      # Make layout background transparent so backdrop wallpaper shows through
      layout.background-color = "transparent";

      animations = {
        slowdown = 1.0;

        window-open.kind = {
          easing = {
            duration-ms = 150;
            curve = "ease-out-expo";
          };
        };

        window-close.kind = {
          easing = {
            duration-ms = 150;
            curve = "ease-out-expo";
          };
        };

        horizontal-view-movement.kind = {
          easing = {
            duration-ms = 150;
            curve = "ease-out-expo";
          };
        };

        workspace-switch.kind = {
          easing = {
            duration-ms = 200;
            curve = "ease-out-expo";
          };
        };
      };

      binds = with config.lib.niri.actions; {
        # Core actions
        "Mod+Q".action = close-window;
        "Mod+Return".action = spawn "${pkgs.ghostty}/bin/ghostty";
        "Mod+Space".action =
          spawn "${inputs.vicinae.packages.${hostSystem}.default}/bin/vicinae"
          "toggle";
        "Mod+T".action = spawn "${toggleTheme}/bin/toggle-theme";
        "Mod+Period".action =
          spawn "${inputs.quickshell.packages.${hostSystem}.default}/bin/qs"
          "ipc" "call" "bar" "toggle";

        # Window state
        "Mod+V".action = toggle-window-floating;
        "Mod+F".action = fullscreen-window;

        # Focus navigation (vim keys and arrows)
        "Mod+Left".action = focus-column-left;
        "Mod+Right".action = focus-column-right;
        "Mod+Up".action = focus-window-or-workspace-up;
        "Mod+Down".action = focus-window-or-workspace-down;
        "Mod+H".action = focus-column-left;
        "Mod+L".action = focus-column-right;
        "Mod+K".action = focus-window-or-workspace-up;
        "Mod+J".action = focus-window-or-workspace-down;

        # Move windows
        "Mod+Shift+Left".action = move-column-left;
        "Mod+Shift+Right".action = move-column-right;
        "Mod+Shift+Up".action = move-window-up-or-to-workspace-up;
        "Mod+Shift+Down".action = move-window-down-or-to-workspace-down;
        "Mod+Shift+H".action = move-column-left;
        "Mod+Shift+L".action = move-column-right;
        "Mod+Shift+K".action = move-window-up-or-to-workspace-up;
        "Mod+Shift+J".action = move-window-down-or-to-workspace-down;

        # Column width presets
        "Mod+R".action = switch-preset-column-width;
        "Mod+Minus".action = set-column-width "-10%";
        "Mod+Equal".action = set-column-width "+10%";

        # Workspaces
        "Mod+1".action = focus-workspace 1;
        "Mod+2".action = focus-workspace 2;
        "Mod+3".action = focus-workspace 3;
        "Mod+4".action = focus-workspace 4;
        "Mod+5".action = focus-workspace 5;
        "Mod+6".action = focus-workspace 6;
        "Mod+7".action = focus-workspace 7;
        "Mod+8".action = focus-workspace 8;
        "Mod+9".action = focus-workspace 9;
        "Mod+0".action = focus-workspace 10;

        # Move to workspace (niri only supports relative movement, not absolute indices)
        # Use Mod+Shift+Up/Down/K/J for moving windows between workspaces

        # Volume controls
        "XF86AudioRaiseVolume".action =
          spawn "wpctl" "set-volume" "@DEFAULT_AUDIO_SINK@" "5%+";
        "XF86AudioLowerVolume".action =
          spawn "wpctl" "set-volume" "@DEFAULT_AUDIO_SINK@" "5%-";
        "XF86AudioMute".action =
          spawn "wpctl" "set-mute" "@DEFAULT_AUDIO_SINK@" "toggle";

        # Monitor focus (for multi-monitor setups)
        "Mod+Ctrl+Left".action = focus-monitor-left;
        "Mod+Ctrl+Right".action = focus-monitor-right;
        "Mod+Ctrl+Up".action = focus-monitor-up;
        "Mod+Ctrl+Down".action = focus-monitor-down;
        "Mod+Ctrl+H".action = focus-monitor-left;
        "Mod+Ctrl+L".action = focus-monitor-right;
        "Mod+Ctrl+K".action = focus-monitor-up;
        "Mod+Ctrl+J".action = focus-monitor-down;

        # Move window to monitor
        "Mod+Shift+Ctrl+Left".action = move-column-to-monitor-left;
        "Mod+Shift+Ctrl+Right".action = move-column-to-monitor-right;
        "Mod+Shift+Ctrl+Up".action = move-column-to-monitor-up;
        "Mod+Shift+Ctrl+Down".action = move-column-to-monitor-down;
        "Mod+Shift+Ctrl+H".action = move-column-to-monitor-left;
        "Mod+Shift+Ctrl+L".action = move-column-to-monitor-right;
        "Mod+Shift+Ctrl+K".action = move-column-to-monitor-up;
        "Mod+Shift+Ctrl+J".action = move-column-to-monitor-down;

        # Workspace reordering (Hyper = Mod+Ctrl+Alt+Shift)
        "Mod+Ctrl+Alt+Shift+Up".action = move-workspace-up;
        "Mod+Ctrl+Alt+Shift+Down".action = move-workspace-down;
        "Mod+Ctrl+Alt+Shift+K".action = move-workspace-up;
        "Mod+Ctrl+Alt+Shift+J".action = move-workspace-down;

        # Move workspace to monitor (Hyper + h/l)
        "Mod+Ctrl+Alt+Shift+Left".action = move-workspace-to-monitor-left;
        "Mod+Ctrl+Alt+Shift+Right".action = move-workspace-to-monitor-right;
        "Mod+Ctrl+Alt+Shift+H".action = move-workspace-to-monitor-left;
        "Mod+Ctrl+Alt+Shift+L".action = move-workspace-to-monitor-right;

        # Help overlay
        "Mod+Shift+Slash".action = show-hotkey-overlay;

        # CleanShot-style capture workflow
        "Super+Shift+2".action = spawn "${cleanshot-niri}/bin/cleanshot-niri" "window";
        "Super+Shift+4".action = spawn "${cleanshot-niri}/bin/cleanshot-niri" "area";
        "Super+Shift+5".action = spawn "${cleanshot-niri}/bin/cleanshot-niri" "record";
        "Super+Shift+3".action = spawn "${cleanshot-niri}/bin/cleanshot-niri" "repeat-area";

        # Mouse bindings
        "Mod+WheelScrollDown" = {
          cooldown-ms = 150;
          action = focus-workspace-down;
        };
        "Mod+WheelScrollUp" = {
          cooldown-ms = 150;
          action = focus-workspace-up;
        };
      };
    };
  };

  home.packages = with pkgs; [
    swaybg
    wl-clipboard
    glib
    xdg-desktop-portal-gtk
    grim
    slurp
    wf-recorder
    satty
    libnotify
    xdg-utils
    toggleTheme
    cleanshot-niri
    lisgd
    lisgd-niri
  ];

  # systemd user service for lisgd - ensures proper group membership (input)
  # niri's spawn-at-startup doesn't inherit login session groups
  systemd.user.services.lisgd-niri = {
    Unit = {
      Description = "Touchscreen gesture daemon for niri";
      After = [ "graphical-session.target" ];
      PartOf = [ "graphical-session.target" ];
    };
    Service = {
      Type = "simple";
      ExecStart = "${lisgd-niri}/bin/lisgd-niri";
      Restart = "on-failure";
      RestartSec = 2;
      # note: user already in "input" group via extraGroups in host config
      # SupplementaryGroups doesn't work in user services (can't change group creds)
    };
    Install = { WantedBy = [ "graphical-session.target" ]; };
  };

  # activation rewrites niri's generated config to append raw KDL below, so home-manager
  # must not preserve an edited copy or create backup conflicts on every switch. remove
  # this force once the raw block is gone and home-manager owns the file normally again.
  xdg.configFile.niri-config.force = true;

  # niri 26.04 added background effects before niri-flake's nix schema exposed them.
  # keep typed settings above for everything the schema understands, then append raw KDL
  # for normal windows and specific material surfaces only. quickshell's overlay host
  # is a fullscreen transparent mask; blurring all overlays makes the wallpaper look
  # blurred even when no app is open. cleanup path: once upstream exposes `blur`,
  # `background-effect`, and `popups`, move this into `programs.niri.settings`, delete
  # `niriBackgroundEffects`, this activation hook, and the forced config ownership.
  home.activation.niriBackgroundEffects =
    lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      config_file="$HOME/.config/niri/config.kdl"
      install -Dm0644 "${config.xdg.configFile.niri-config.source}" "$config_file"
      cat "${niriBackgroundEffects}" >> "$config_file"
    '';

  dconf.enable = true;
  dconf.settings = {
    "org/gnome/desktop/interface" = {
      color-scheme = "prefer-dark";
      cursor-theme = "macOS";
      cursor-size = lib.mkDefault 24;
    };
  };
}

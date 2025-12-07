{ pkgs, lib, config, hostSystem ? null, ... }:

let
  toggleTheme = pkgs.writeShellScriptBin "toggle-theme" ''
    export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus"
    export XDG_DATA_DIRS="${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}:${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}''${XDG_DATA_DIRS:+:$XDG_DATA_DIRS}"
    current=$(${pkgs.glib}/bin/gsettings get org.gnome.desktop.interface color-scheme)
    if [ "$current" = "'prefer-dark'" ]; then
      ${pkgs.glib}/bin/gsettings set org.gnome.desktop.interface color-scheme prefer-light
    else
      ${pkgs.glib}/bin/gsettings set org.gnome.desktop.interface color-scheme prefer-dark
    fi
  '';
in

if !(lib.hasInfix "linux" hostSystem) then {} else {
  programs.niri = {
    settings = {
      # Startup applications - same as hyprland
      spawn-at-startup = [
        { argv = [ "swaybg" "-i" "/etc/wallpaper.jpg" "-m" "fill" ]; }
        { argv = [ "waybar" ]; }
        { argv = [ "vicinae" "server" ]; }
        { argv = [ "xwayland-satellite" ":0" ]; }
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
      };

      # Input configuration
      input = {
        keyboard.xkb.layout = "us";
        mouse.accel-profile = "flat";
        touchpad = {
          tap = true;
          natural-scroll = true;
        };
      };

      # Output/monitor config (use `niri msg outputs` to find names)
      # TODO: update output name for your actual monitor
      outputs."eDP-1" = {
        scale = 1.5;
      };

      # Cursor
      cursor = {
        theme = "macOS";
        size = 24;
      };

      # Layout - niri's scrolling layout with gaps matching hyprland
      layout = {
        gaps = 8;
        
        # No borders (matching hyprland border_size = 0)
        border.enable = false;
        focus-ring.enable = false;
        
        # Center single windows
        center-focused-column = "on-overflow";
        
        # Default column width
        default-column-width.proportion = 0.5;
        
        # Preset column widths for Mod+R cycling
        preset-column-widths = [
          { proportion = 1.0 / 3.0; }
          { proportion = 0.5; }
          { proportion = 2.0 / 3.0; }
          { proportion = 1.0; }
        ];
      };

      # Window decorations
      prefer-no-csd = true;
      
      # Window rules for rounding (matching hyprland rounding = 8)
      window-rules = [
        {
          geometry-corner-radius = {
            top-left = 8.0;
            top-right = 8.0;
            bottom-right = 8.0;
            bottom-left = 8.0;
          };
          clip-to-geometry = true;
        }
      ];

      # Animations - matching hyprland's easeOutQuint feel (using ease-out-expo, closest available)
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

      # Keybindings - matching hyprland binds
      binds = with config.lib.niri.actions; {
        # Core actions
        "Mod+Q".action = close-window;
        "Mod+Return".action = spawn "ghostty";
        "Mod+Space".action = spawn "vicinae" "toggle";
        "Mod+T".action = spawn "${toggleTheme}/bin/toggle-theme";
        
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
        "XF86AudioRaiseVolume".action = spawn "wpctl" "set-volume" "@DEFAULT_AUDIO_SINK@" "5%+";
        "XF86AudioLowerVolume".action = spawn "wpctl" "set-volume" "@DEFAULT_AUDIO_SINK@" "5%-";
        "XF86AudioMute".action = spawn "wpctl" "set-mute" "@DEFAULT_AUDIO_SINK@" "toggle";
        
        # Mouse bindings
        "Mod+WheelScrollDown" = { cooldown-ms = 150; action = focus-workspace-down; };
        "Mod+WheelScrollUp" = { cooldown-ms = 150; action = focus-workspace-up; };
      };
    };
  };
  
  home.packages = with pkgs; [
    swaybg
    wl-clipboard
    glib
    xdg-desktop-portal-gtk
    toggleTheme
  ];
  
  dconf.enable = true;
  dconf.settings = {
    "org/gnome/desktop/interface" = {
      color-scheme = "prefer-dark";
      cursor-theme = "macOS";
      cursor-size = 24;
    };
  };
}

# niri window manager configuration optimized for 4K display
# LG HDR 4K: 3840x2160 @ 60Hz (scaled to 2560x1440)
{ config, pkgs, lib, isNixOS ? false, hasNvidia ? false, ... }:

{
  # Wayland-specific applications optimized for 4K
  home.packages = with pkgs; [
    # Terminal emulators with good 4K support
    foot
    alacritty
    wezterm
    
    # Application launcher with 4K scaling
    fuzzel
    rofi-wayland
    wofi
    
    # Screenshot tools
    grim
    slurp
    swappy
    wl-clipboard
    
    # File manager with good 4K support
    nautilus
    thunar
    
    # Media players optimized for 4K
    mpv
    vlc
    imv
    
    # Wayland-native applications
    firefox-wayland
    
    # System monitoring with GPU support
    nvtop
    wlr-randr
    wayland-utils
    
    # 4K-friendly productivity apps
    obsidian
    vscode
    
    # Audio control
    pwvucontrol
    pavucontrol
    
    # Notification and bar
    mako
    waybar
    
    # Network management GUI
    networkmanagerapplet
    
    # Bluetooth management
    blueman
    
    # System utilities
    polkit_gnome
    
  ] ++ lib.optionals isNixOS [
    # NixOS-specific packages
    gnome.gnome-keyring
    gnome.seahorse
    
    # Gaming with 4K support
    steam
    lutris
    mangohud
    
    # Video editing for 4K content
    kdenlive
    davinci-resolve  # If available
    
  ] ++ lib.optionals hasNvidia [
    # NVIDIA-specific tools
    nvidia-smi
    nvtop
  ];

  # niri configuration optimized for 4K display
  programs.niri = {
    settings = {
      # Input configuration
      input = {
        keyboard = {
          xkb = {
            layout = "us";
            options = "caps:escape,compose:ralt";
          };
          repeat-delay = 600;
          repeat-rate = 25;
        };
        
        mouse = {
          accel-profile = "flat";  # Disable acceleration for precision
          accel-speed = 0.0;
        };
        
        touchpad = {
          tap = true;
          dwt = true;  # Disable while typing
          natural-scroll = true;
          click-method = "clickfinger";
          scroll-method = "two-finger";
          accel-profile = "adaptive";
        };
      };
      
      # Output configuration for 4K display
      outputs."LG HDR 4K" = {
        # Use native 4K resolution
        mode = "3840x2160@60.000";
        
        # Scale factor for comfortable viewing
        scale = 1.5;  # Results in effective 2560x1440
        
        # Position (adjust if using multiple monitors)
        position = { x = 0; y = 0; };
        
        # Color and HDR settings
        variable-refresh-rate = false;  # Enable if supported
        
        # Transform if needed
        transform = "normal";
      };
      
      # Layout configuration optimized for large display
      layout = {
        # Gaps between windows (scaled for 4K)
        gaps = 24;  # Larger gaps for 4K
        
        # Focus behavior
        center-focused-column = "never";
        
        # Column width presets for 4K productivity
        preset-column-widths = [
          { proportion = 1.0/4.0; }   # Quarter width for sidebars
          { proportion = 1.0/3.0; }   # Third width for references
          { proportion = 1.0/2.0; }   # Half width for code/writing
          { proportion = 2.0/3.0; }   # Two-thirds for main content
          { proportion = 3.0/4.0; }   # Three-quarters for media
        ];
        
        # Default column width
        default-column-width = { proportion = 1.0/2.0; };
        
        # Border configuration
        border = {
          enable = true;
          width = 3;  # Thicker borders for 4K visibility
          active.color = "#7aa2f7";     # Tokyo Night blue
          inactive.color = "#414868";   # Tokyo Night dark blue
        };
        
        # Focus ring
        focus-ring = {
          enable = true;
          width = 4;
          active.color = "#bb9af7";     # Tokyo Night purple
          inactive.color = "#414868";
        };
        
        # Struts for system bars
        struts = {
          left = 0;
          right = 0;
          top = 48;     # Space for waybar (scaled for 4K)
          bottom = 0;
        };
      };
      
      # Workspace configuration for 4K productivity
      workspaces = {
        "1" = {
          name = "Main";
          open-on-output = "LG HDR 4K";
        };
        "2" = {
          name = "Dev";
          open-on-output = "LG HDR 4K";
        };
        "3" = {
          name = "Web";
          open-on-output = "LG HDR 4K";
        };
        "4" = {
          name = "Media";
          open-on-output = "LG HDR 4K";
        };
        "5" = {
          name = "Games";
          open-on-output = "LG HDR 4K";
        };
      };
      
      # Window rules for specific applications
      window-rules = [
        {
          matches = [
            { app-id = "^firefox$"; }
            { app-id = "^firefox-wayland$"; }
          ];
          default-column-width = { proportion = 2.0/3.0; };
        }
        
        {
          matches = [ { app-id = "^code$"; } ];
          open-on-workspace = "Dev";
          default-column-width = { proportion = 3.0/4.0; };
        }
        
        {
          matches = [
            { app-id = "^mpv$"; }
            { app-id = "^vlc$"; }
          ];
          open-on-workspace = "Media";
          open-fullscreen = true;
        }
        
        {
          matches = [
            { app-id = "^steam$"; }
            { app-id = "^lutris$"; }
          ];
          open-on-workspace = "Games";
        }
        
        # Floating windows for dialogs
        {
          matches = [
            { title = "^Open File$"; }
            { title = "^Save File$"; }
            { app-id = "^org.gnome.Nautilus$"; }
          ];
          open-floating = true;
        }
      ];
      
      # Startup applications
      spawn-at-startup = [
        { command = [ "waybar" ]; }
        { command = [ "mako" ]; }
        { command = [ "nm-applet" ]; }
        { command = [ "blueman-applet" ]; }
        { command = [ "${pkgs.polkit_gnome}/libexec/polkit-gnome-authentication-agent-1" ]; }
        
        # Auto-start terminal on workspace 1
        { command = [ "foot" ]; }
        
        # Background services
        { command = [ "wl-paste" "--watch" "cliphist" "store" ]; }
      ];
      
      # Environment variables
      environment = {
        # Qt scaling
        QT_AUTO_SCREEN_SCALE_FACTOR = "1";
        QT_SCALE_FACTOR = "1.5";
        QT_FONT_DPI = "144";
        
        # GTK scaling
        GDK_SCALE = "1.5";
        GDK_DPI_SCALE = "1";
        
        # Cursor size for 4K
        XCURSOR_SIZE = "48";
        
        # NVIDIA-specific environment variables
      } // lib.optionalAttrs hasNvidia {
        LIBVA_DRIVER_NAME = "nvidia";
        GBM_BACKEND = "nvidia-drm";
        __GLX_VENDOR_LIBRARY_NAME = "nvidia";
        WLR_NO_HARDWARE_CURSORS = "1";
      };
      
      # Cursor configuration
      cursor = {
        size = 48;  # Larger cursor for 4K
        theme = "Adwaita";
      };
      
      # Keybindings optimized for productivity
      binds = with config.lib.niri.actions; {
        # Window management
        "Mod+H".action = focus-column-left;
        "Mod+L".action = focus-column-right;
        "Mod+J".action = focus-window-down;
        "Mod+K".action = focus-window-up;
        
        # Window movement
        "Mod+Shift+H".action = move-column-left;
        "Mod+Shift+L".action = move-column-right;
        "Mod+Shift+J".action = move-window-down;
        "Mod+Shift+K".action = move-window-up;
        
        # Column management
        "Mod+Ctrl+H".action = focus-monitor-left;
        "Mod+Ctrl+L".action = focus-monitor-right;
        "Mod+Shift+Ctrl+H".action = move-column-to-monitor-left;
        "Mod+Shift+Ctrl+L".action = move-column-to-monitor-right;
        
        # Window sizing
        "Mod+R".action = switch-preset-column-width;
        "Mod+Shift+R".action = reset-window-height;
        "Mod+F".action = maximize-column;
        "Mod+Shift+F".action = fullscreen-window;
        
        # Applications
        "Mod+Return".action = spawn "foot";
        "Mod+D".action = spawn "fuzzel";
        "Mod+E".action = spawn "nautilus";
        "Mod+B".action = spawn "firefox";
        "Mod+C".action = spawn "code";
        
        # Screenshots (4K-aware)
        "Print".action = spawn "grim" "screenshot-$(date +%Y%m%d-%H%M%S).png";
        "Shift+Print".action = spawn "grim" "-g" "$(slurp)" "screenshot-$(date +%Y%m%d-%H%M%S).png";
        "Ctrl+Print".action = spawn "grim" "-g" "$(slurp)" "-" "|" "wl-copy";
        
        # System controls
        "Mod+Q".action = close-window;
        "Mod+Shift+E".action = quit-niri;
        
        # Audio controls
        "XF86AudioRaiseVolume".action = spawn "wpctl" "set-volume" "@DEFAULT_AUDIO_SINK@" "0.1+";
        "XF86AudioLowerVolume".action = spawn "wpctl" "set-volume" "@DEFAULT_AUDIO_SINK@" "0.1-";
        "XF86AudioMute".action = spawn "wpctl" "set-mute" "@DEFAULT_AUDIO_SINK@" "toggle";
        
        # Brightness controls
        "XF86MonBrightnessUp".action = spawn "light" "-A" "5";
        "XF86MonBrightnessDown".action = spawn "light" "-U" "5";
        
        # Workspaces
        "Mod+1".action = focus-workspace 1;
        "Mod+2".action = focus-workspace 2;
        "Mod+3".action = focus-workspace 3;
        "Mod+4".action = focus-workspace 4;
        "Mod+5".action = focus-workspace 5;
        
        "Mod+Shift+1".action = move-column-to-workspace 1;
        "Mod+Shift+2".action = move-column-to-workspace 2;
        "Mod+Shift+3".action = move-column-to-workspace 3;
        "Mod+Shift+4".action = move-column-to-workspace 4;
        "Mod+Shift+5".action = move-column-to-workspace 5;
      };
      
      # Animations optimized for 4K/120Hz (if supported)
      animations = {
        shaders.window-resize = "default";
        window-movement.spring = {
          damping-ratio = 1.0;
          stiffness = 800;
          epsilon = 0.0001;
        };
        workspace-switch.slide = {
          duration-ms = 250;
        };
      };
    };
  };

  # Wayland-specific services for 4K setup
  services = {
    # Notification daemon
    mako = {
      enable = true;
      backgroundColor = "#1a1b26";
      textColor = "#c0caf5";
      borderColor = "#7aa2f7";
      borderSize = 2;
      borderRadius = 8;
      width = 450;  # Scaled for 4K
      height = 150;
      defaultTimeout = 5000;
      font = "Fira Code 12";
      maxIconSize = 96;  # Larger icons for 4K
    };
    
    # Clipboard manager
    clipman.enable = true;
    
    # Auto-mounting
    udiskie = {
      enable = true;
      automount = true;
      notify = true;
    };
  };

  # Terminal configuration optimized for 4K
  programs = {
    foot = {
      enable = true;
      settings = {
        main = {
          term = "xterm-256color";
          font = "Fira Code:size=14";  # Larger font for 4K
          dpi-aware = "yes";
          pad = "24x24";  # More padding for 4K
        };
        
        mouse = {
          hide-when-typing = "yes";
        };
        
        colors = {
          # Tokyo Night theme
          foreground = "c0caf5";
          background = "1a1b26";
          
          # Normal colors
          regular0 = "15161e";
          regular1 = "f7768e";
          regular2 = "9ece6a";
          regular3 = "e0af68";
          regular4 = "7aa2f7";
          regular5 = "bb9af7";
          regular6 = "7dcfff";
          regular7 = "a9b1d6";
          
          # Bright colors
          bright0 = "414868";
          bright1 = "f7768e";
          bright2 = "9ece6a";
          bright3 = "e0af68";
          bright4 = "7aa2f7";
          bright5 = "bb9af7";
          bright6 = "7dcfff";
          bright7 = "c0caf5";
        };
      };
    };
    
    # Application launcher optimized for 4K
    fuzzel = {
      enable = true;
      settings = {
        main = {
          font = "Fira Code:size=16";  # Larger font for 4K
          dpi-aware = "yes";
          terminal = "foot";
          layer = "overlay";
          width = 60;
          horizontal-pad = 32;
          vertical-pad = 16;
          inner-pad = 16;
          image-size-ratio = 0.8;
          icon-theme = "Adwaita";
        };
        
        colors = {
          background = "1a1b26dd";
          text = "c0caf5ff";
          match = "7aa2f7ff";
          selection = "414868ff";
          selection-text = "c0caf5ff";
          selection-match = "bb9af7ff";
          border = "7aa2f7ff";
        };
        
        border = {
          width = 2;
          radius = 8;
        };
      };
    };
  };

  # Environment variables for 4K scaling
  home.sessionVariables = {
    # Qt applications
    QT_AUTO_SCREEN_SCALE_FACTOR = "1";
    QT_SCALE_FACTOR = "1.5";
    QT_FONT_DPI = "144";
    
    # GTK applications
    GDK_SCALE = "1.5";
    GDK_DPI_SCALE = "1";
    
    # Cursor size
    XCURSOR_SIZE = "48";
    
    # Wayland
    XDG_SESSION_TYPE = "wayland";
    XDG_CURRENT_DESKTOP = "niri";
    
    # Applications
    NIXOS_OZONE_WL = "1";      # Chromium/Electron
    MOZ_ENABLE_WAYLAND = "1";  # Firefox
    
  } // lib.optionalAttrs hasNvidia {
    # NVIDIA-specific variables
    LIBVA_DRIVER_NAME = "nvidia";
    GBM_BACKEND = "nvidia-drm";
    __GLX_VENDOR_LIBRARY_NAME = "nvidia";
    WLR_NO_HARDWARE_CURSORS = "1";
  };

  # GTK configuration for consistent 4K scaling
  gtk = {
    enable = true;
    theme = {
      name = "Adwaita-dark";
      package = pkgs.gnome.gnome-themes-extra;
    };
    
    iconTheme = {
      name = "Adwaita";
      package = pkgs.gnome.adwaita-icon-theme;
    };
    
    cursorTheme = {
      name = "Adwaita";
      package = pkgs.gnome.adwaita-icon-theme;
      size = 48;
    };
    
    font = {
      name = "Noto Sans";
      size = 12;
    };
    
    gtk3.extraConfig = {
      gtk-application-prefer-dark-theme = true;
      gtk-cursor-theme-size = 48;
      gtk-xft-dpi = 147456;  # 144 * 1024
    };
    
    gtk4.extraConfig = {
      gtk-application-prefer-dark-theme = true;
      gtk-cursor-theme-size = 48;
    };
  };

  # Qt configuration for 4K
  qt = {
    enable = true;
    platformTheme = "qtct";
    style = {
      name = "adwaita-dark";
      package = pkgs.adwaita-qt;
    };
  };
}
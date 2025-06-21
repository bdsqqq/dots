# Home Manager configuration integrating existing modules
{ config, pkgs, lib, inputs, unstable, ... }:

{
  # Import existing home-manager modules (adjusted paths)
  imports = [
    # Adjust these paths based on your actual structure
    ../modules/home-manager/development.nix
    ../modules/home-manager/shell.nix  
    # Skip neovim.nix to avoid nixvim conflicts in VM
    # Skip applications.nix for now, we'll handle GUI apps separately
  ];

  # Home Manager basics
  home = {
    username = "bdsqqq";
    homeDirectory = "/home/bdsqqq";
    stateVersion = "23.11";
  };

  # Enable home-manager service
  programs.home-manager.enable = true;

  # Basic niri configuration via raw config file
  # Note: Using niri system configuration instead of home-manager module
  # to avoid potential module conflicts in VM environment

  # Waybar configuration
  programs.waybar = {
    enable = true;
    settings = [{
      layer = "top";
      position = "top";
      height = 30;
      
      modules-left = [ "niri/workspaces" "niri/window" ];
      modules-center = [ "clock" ];
      modules-right = [ "pulseaudio" "network" "battery" "tray" ];
      
      "niri/workspaces" = {
        format = "{name}";
      };
      
      "niri/window" = {
        format = "{}";
        max-length = 50;
      };
      
      clock = {
        format = "{:%Y-%m-%d %H:%M}";
        tooltip-format = "<big>{:%Y %B}</big>\n<tt><small>{calendar}</small></tt>";
      };
      
      pulseaudio = {
        format = "{icon} {volume}%";
        format-muted = "🔇";
        format-icons = ["🔈" "🔉" "🔊"];
        on-click = "pavucontrol";
      };
      
      network = {
        format-wifi = "📶 {signalStrength}%";
        format-ethernet = "🔌";
        format-disconnected = "❌";
        tooltip-format = "{ifname}: {ipaddr}";
      };
      
      battery = {
        format = "{icon} {capacity}%";
        format-icons = ["🪫" "🔋"];
        format-charging = "🔌 {capacity}%";
      };
    }];
    
    style = ''
      * {
        border: none;
        border-radius: 0;
        font-family: "JetBrains Mono";
        font-size: 13px;
        min-height: 0;
      }
      
      window#waybar {
        background-color: rgba(43, 48, 59, 0.8);
        color: #ffffff;
        transition-property: background-color;
        transition-duration: .5s;
      }
      
      #workspaces button {
        padding: 0 5px;
        background-color: transparent;
        color: #ffffff;
        border-bottom: 3px solid transparent;
      }
      
      #workspaces button.focused {
        background-color: #64727D;
        border-bottom: 3px solid #ffffff;
      }
      
      #clock, #battery, #pulseaudio, #network, #window {
        padding: 0 10px;
        margin: 0 4px;
      }
    '';
  };

  # Fuzzel app launcher
  programs.fuzzel = {
    enable = true;
    settings = {
      main = {
        terminal = "alacritty";
        layer = "overlay";
      };
      colors = {
        background = "282c34dd";
        text = "abb2bfff";
        match = "61afefff";
        selection = "3e4451ff";
        selection-text = "abb2bfff";
        selection-match = "61afefff";
        border = "61afefff";
      };
    };
  };

  # Mako notification daemon
  services.mako = {
    enable = true;
    backgroundColor = "#282c34";
    textColor = "#abb2bf";
    borderColor = "#61afef";
    borderRadius = 5;
    defaultTimeout = 5000;
    layer = "overlay";
  };

  # Swaylock configuration
  programs.swaylock = {
    enable = true;
    settings = {
      color = "000000";
      font-size = 24;
      indicator-idle-visible = false;
      indicator-radius = 100;
      show-failed-attempts = true;
    };
  };

  # Swayidle for automatic locking
  services.swayidle = {
    enable = true;
    events = [
      { event = "before-sleep"; command = "${pkgs.swaylock}/bin/swaylock -fF"; }
    ];
    timeouts = [
      { timeout = 300; command = "${pkgs.swaylock}/bin/swaylock -fF"; }
      { timeout = 600; command = "${pkgs.systemd}/bin/systemctl suspend"; }
    ];
  };

  # Terminal configuration
  programs.alacritty = {
    enable = true;
    settings = {
      font = {
        normal.family = "JetBrains Mono";
        size = 12;
      };
      colors = {
        primary = {
          background = "#282c34";
          foreground = "#abb2bf";
        };
      };
      window = {
        opacity = 0.95;
        padding = {
          x = 10;
          y = 10;
        };
      };
    };
  };

  # GUI applications for Wayland
  home.packages = with pkgs; [
    # Core GUI applications
    firefox-wayland
    _1password-gui
    obsidian
    
    # Media applications  
    mpv
    imv  # Image viewer
    
    # Development tools
    vscode-fhs
    
    # System utilities
    wdisplays      # Display configuration GUI
    wlr-randr      # Display configuration CLI
    wev            # Wayland event viewer (debugging)
    
    # File manager with Wayland support
    nautilus
    
    # Additional Wayland tools
    wtype          # Type text (wayland xdotool)
    ydotool        # Generic input automation
    
    # Screenshot tools
    grim
    slurp
    
    # Clipboard tools
    wl-clipboard
    
    # Color picker
    hyprpicker
  ] ++ (with unstable; [
    # Bleeding edge packages if needed
  ]);

  # XDG directories
  xdg = {
    enable = true;
    userDirs = {
      enable = true;
      createDirectories = true;
    };
  };

  # Environment variables for Wayland
  home.sessionVariables = {
    NIXOS_OZONE_WL = "1";
    MOZ_ENABLE_WAYLAND = "1";
    QT_QPA_PLATFORM = "wayland";
    SDL_VIDEODRIVER = "wayland";
    XDG_SESSION_TYPE = "wayland";
    XDG_CURRENT_DESKTOP = "niri";
  };

  # GTK configuration for consistent theming
  gtk = {
    enable = true;
    theme = {
      package = pkgs.adw-gtk3;
      name = "adw-gtk3";
    };
    iconTheme = {
      package = pkgs.adwaita-icon-theme;
      name = "Adwaita";
    };
  };

  # Qt configuration
  qt = {
    enable = true;
    platformTheme = "gtk";
    style = {
      package = pkgs.adwaita-qt;
      name = "adwaita";
    };
  };
}

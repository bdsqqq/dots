{ config, pkgs, lib, ... }:

{
  # Waybar dependencies and utilities
  home.packages = with pkgs; [
    jq         # JSON processor for notification scripts
    socat      # Socket communication utilities  
    fzf        # Fuzzy finder for interactive menus
    wireplumber # Audio session manager (ensures wpctl availability)
  ];

  programs.waybar = {
    enable = true;
    package = pkgs.waybar;
    
    settings = {
      mainBar = {
        # Non-exclusive positioning (no space reserved)
        layer = "top";
        position = "top";
        height = 32;
        spacing = 0;
        margin-top = 8;
        margin-right = 8;
        exclusive = false;
        
        # Only essential widgets on the right
        modules-left = [ ];
        modules-center = [ ];
        modules-right = [ "custom/bluetooth" "pulseaudio" "network" "custom/notification" "clock" ];
        
        # Bluetooth widget
        "custom/bluetooth" = {
          format = "{}";
          interval = 5;
          exec = "~/.config/waybar/scripts/bluetooth.sh";
          on-click = "blueman-manager";
          on-click-right = "blueman-manager";
        };
        
        # Audio control
        pulseaudio = {
          format = "{icon}";
          format-muted = "󰝟";
          format-icons = {
            default = [ "󰕿" "󰖀" "󰕾" ];
          };
          on-click = "wpctl set-mute @DEFAULT_AUDIO_SINK@ toggle";
          on-click-right = "~/.config/waybar/scripts/audio-menu.sh";
          on-scroll-up = "wpctl set-volume @DEFAULT_AUDIO_SINK@ 2%+";
          on-scroll-down = "wpctl set-volume @DEFAULT_AUDIO_SINK@ 2%-";
        };
        
        # Network
        network = {
          format-wifi = "󰖩";
          format-ethernet = "󰈀";
          format-disconnected = "󰖪";
          on-click = "networkmanager_dmenu";
        };
        
        # Notifications
        "custom/notification" = {
          format = "{}";
          interval = 1;
          exec = "~/.config/waybar/scripts/notifications.sh";
          on-click = "makoctl dismiss --all";
          on-click-right = "makoctl restore";
        };
        
        # Clock
        clock = {
          format = "{:%H:%M}";
          format-alt = "{:%A, %B %d}";
        };
      };
    };
    
    # Clean styling without CSS transforms
    style = ''
      * {
        font-family: "JetBrainsMono Nerd Font";
        font-size: 11px;
        font-weight: 400;
        border: none;
        border-radius: 0;
        min-height: 0;
        margin: 0;
        padding: 0;
      }
      
      window#waybar {
        background: transparent;
        color: #c2c2c2;
      }
      
      .modules-right {
        background: rgba(16, 16, 16, 0.92);
        border-radius: 4px;
        margin: 0;
        padding: 0 12px 0 8px;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
      }
      
      /* All widgets visible */
      #custom-bluetooth,
      #pulseaudio,
      #network,
      #custom-notification,
      #clock {
        padding: 6px 8px;
        color: #868686;
        font-size: 10px;
        min-width: 24px;
      }
      
      /* Clock styling */
      #clock {
        color: #c2c2c2;
        font-weight: 300;
        letter-spacing: 0.5px;
        min-width: 48px;
      }
      
      /* Hover effects for individual widgets */
      #custom-bluetooth:hover,
      #pulseaudio:hover,
      #network:hover,
      #custom-notification:hover {
        color: #c2c2c2;
        transition: color 150ms ease;
      }
      
      /* State colors */
      #pulseaudio.muted {
        color: #5e5e5e;
      }
      
      #network.disconnected {
        color: #5e5e5e;
      }
    '';
  };
}
{ config, pkgs, lib, ... }:

{
  programs.waybar = {
    enable = true;
    package = pkgs.waybar;
    
    settings = {
      mainBar = {
        # Positioning - minimal, floating aesthetic
        layer = "top";
        position = "top";
        height = 32;
        spacing = 0;
        margin-top = 8;
        margin-left = 8;
        margin-right = 8;
        
        # Modules layout - Nothing/Bauhaus inspired simplicity
        modules-left = [ "custom/launcher" "niri/workspaces" "custom/system-monitor" ];
        modules-center = [ "niri/window" ];
        modules-right = [ "custom/bluetooth" "pulseaudio" "network" "battery" "custom/notification" "clock" "custom/power" ];
        
        # Module configurations
        "custom/launcher" = {
          format = "◯";  # Nothing-inspired dot
          tooltip-format = "Applications";
          on-click = "fuzzel";
        };
        
        "niri/workspaces" = {
          format = "{icon}";
          format-icons = {
            "1" = "○";
            "2" = "○"; 
            "3" = "○";
            "4" = "○";
            "5" = "○";
            active = "●";
            urgent = "◉";
            default = "○";
          };
          persistent-workspaces = {
            "1" = [];
            "2" = [];
            "3" = [];
            "4" = [];
            "5" = [];
          };
        };
        
        "niri/window" = {
          format = "{title}";
          max-length = 60;
          tooltip = false;
          rewrite = {
            "^$" = "Desktop";
            "^(.{50}).*" = "$1...";
          };
        };
        
        pulseaudio = {
          format = "{icon} {volume}%";
          format-muted = "󰝟";
          format-icons = {
            headphone = "󰋋";
            hands-free = "󰋋";  
            headset = "󰋋";
            phone = "";
            portable = "";
            car = "";
            default = [ "󰕿" "󰖀" "󰕾" ];
          };
          tooltip-format = "{desc} • Right-click for output menu";
          on-click = "wpctl set-mute @DEFAULT_AUDIO_SINK@ toggle";
          on-click-right = "~/.config/waybar/scripts/audio-menu.sh";
          on-scroll-up = "wpctl set-volume @DEFAULT_AUDIO_SINK@ 2%+";
          on-scroll-down = "wpctl set-volume @DEFAULT_AUDIO_SINK@ 2%-";
        };
        
        network = {
          format-wifi = "󰖩 {signalStrength}%";
          format-ethernet = "󰈀";
          format-disconnected = "󰖪";
          tooltip-format-wifi = "{essid} ({signalStrength}%)";
          tooltip-format-ethernet = "{ifname}";
          on-click = "nm-connection-editor";
        };
        
        battery = {
          states = {
            warning = 30;
            critical = 15;
          };
          format = "{icon} {capacity}%";
          format-charging = "󰂄 {capacity}%";
          format-plugged = "󰂄 {capacity}%";
          format-icons = [ "󰁺" "󰁻" "󰁼" "󰁽" "󰁾" "󰁿" "󰂀" "󰂁" "󰂂" "󰁹" ];
          tooltip-format = "{timeTo}";
        };
        
        clock = {
          format = "{:%H:%M}";
          format-alt = "{:%A, %B %d, %Y}";
          tooltip-format = "<big>{:%Y %B}</big>\n<tt><small>{calendar}</small></tt>";
        };
        
        "custom/power" = {
          format = "⏻";
          tooltip-format = "Power Menu";
          on-click = "~/.config/waybar/scripts/power-menu.sh";
        };
        
        # Bluetooth widget - elegant device management
        "custom/bluetooth" = {
          format = "{}";
          interval = 5;
          exec = "~/.config/waybar/scripts/bluetooth.sh";
          tooltip-format = "Bluetooth: Click to toggle";
          on-click = "~/.config/waybar/scripts/bluetooth-toggle.sh";
          on-click-right = "~/.config/waybar/scripts/bluetooth-menu.sh";
        };
        
        # Enhanced notification widget
        "custom/notification" = {
          format = "{}";
          interval = 1;
          exec = "~/.config/waybar/scripts/notifications.sh";
          tooltip-format = "Notifications: {} active";
          on-click = "makoctl dismiss --all";
          on-click-right = "makoctl restore";
        };
        
        # System monitor widget - CPU, Memory, Temperature
        "custom/system-monitor" = {
          format = "{}";
          interval = 2;
          exec = "~/.config/waybar/scripts/system-monitor.sh";
          tooltip-format = "System: Click for details";
          on-click = "~/.config/waybar/scripts/system-details.sh";
        };
      };
    };
    
    # Minimalist styling inspired by Nothing/Bauhaus/Rams
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
      
      .modules-left,
      .modules-center,
      .modules-right {
        background: rgba(16, 16, 16, 0.92);
        border-radius: 4px;
        margin: 0 4px;
        /* backdrop-filter: blur(8px); */
        /* -webkit-backdrop-filter: blur(8px); */
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
      }
      
      .modules-left {
        margin-left: 0;
        padding: 0 8px 0 12px;
      }
      
      .modules-center {
        padding: 0 16px;
      }
      
      .modules-right {
        margin-right: 0;
        padding: 0 12px 0 8px;
      }
      
      /* Individual modules */
      #custom-launcher,
      #workspaces,
      #custom-system-monitor,
      #window,
      #custom-bluetooth,
      #pulseaudio,
      #network,
      #battery,
      #custom-notification,
      #clock,
      #custom-power {
        padding: 6px 8px;
        color: #c2c2c2;
        background: transparent;
      }
      
      /* Launcher */
      #custom-launcher {
        font-size: 14px;
        padding-right: 12px;
        color: #868686;
      }
      
      #custom-launcher:hover {
        color: #c2c2c2;
        transition: color 150ms cubic-bezier(0.25, 0.46, 0.45, 0.94);
      }
      
      /* Workspaces - Nothing-inspired dots */
      #workspaces {
        padding: 0;
      }
      
      #workspaces button {
        padding: 6px 8px;
        color: #5e5e5e;
        background: transparent;
        border-radius: 0;
        transition: color 150ms cubic-bezier(0.25, 0.46, 0.45, 0.94);
      }
      
      #workspaces button.active {
        color: #c2c2c2;
      }
      
      #workspaces button.urgent {
        color: #9a9a9a;
      }
      
      #workspaces button:hover {
        color: #aeaeae;
        box-shadow: none;
      }
      
      /* Window title */
      #window {
        font-weight: 300;
        color: #868686;
        font-size: 10px;
        letter-spacing: 0.5px;
      }
      
      /* System modules */
      #custom-bluetooth,
      #pulseaudio,
      #network,
      #battery,
      #custom-notification {
        font-size: 10px;
        color: #868686;
        min-width: 24px;
      }
      
      /* Bluetooth widget */
      #custom-bluetooth {
        color: #868686;
      }
      
      #custom-bluetooth.connected {
        color: #c2c2c2;
      }
      
      #custom-bluetooth.disconnected {
        color: #5e5e5e;
      }
      
      /* Notification widget */
      #custom-notification {
        color: #868686;
      }
      
      #custom-notification.has-notifications {
        color: #c2c2c2;
      }
      
      /* System monitor widget */
      #custom-system-monitor {
        color: #868686;
        font-size: 9px;
        padding: 6px 12px;
        letter-spacing: 0.5px;
      }
      
      #custom-system-monitor.high-usage {
        color: #c2c2c2;
      }
      
      #pulseaudio.muted {
        color: #5e5e5e;
      }
      
      #battery.warning {
        color: #9a9a9a;
      }
      
      #battery.critical {
        color: #7c7c7c;
      }
      
      #network.disconnected {
        color: #5e5e5e;
      }
      
      /* Clock - emphasis */
      #clock {
        font-weight: 300;
        color: #c2c2c2;
        font-size: 11px;
        letter-spacing: 0.5px;
        min-width: 48px;
      }
      
      /* Power button */
      #custom-power {
        padding-left: 12px;
        color: #7c7c7c;
        font-size: 12px;
      }
      
      #custom-power:hover {
        color: #c2c2c2;
        transition: color 150ms cubic-bezier(0.25, 0.46, 0.45, 0.94);
      }
      
      /* Hover effects for all interactive elements */
      #custom-system-monitor:hover,
      #custom-bluetooth:hover,
      #pulseaudio:hover,
      #network:hover,
      #battery:hover,
      #custom-notification:hover {
        color: #aeaeae;
        transition: color 150ms cubic-bezier(0.25, 0.46, 0.45, 0.94);
      }
      
      /* Tooltips */
      tooltip {
        background: rgba(16, 16, 16, 0.95);
        border: 1px solid #333333;
        border-radius: 4px;
        color: #c2c2c2;
        font-size: 10px;
      }
    '';
  };
}
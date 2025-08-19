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
        
        # System monitoring and essential widgets
        modules-left = [ ];
        modules-center = [ ];
        modules-right = [ 
          "cpu" 
          "memory" 
          "temperature" 
          "custom/system"
          "bluetooth" 
          "custom/audio" 
          "network" 
          "custom/logs"
          "clock" 
        ];
        
        # System monitoring scratchpad
        "custom/system" = {
          format = "󰔟";
          tooltip-text = "System Management";
          on-click = "pypr toggle system-popup";
        };
        
        # CPU monitoring
        cpu = {
          format = "󰻠 {usage}%";
          interval = 2;
          on-click = "pypr toggle btop-popup";
        };
        
        # Memory monitoring  
        memory = {
          format = "󰍛 {percentage}%";
          interval = 2;
          on-click = "pypr toggle btop-popup";
        };
        
        # Temperature monitoring
        temperature = {
          thermal-zone = 0;
          format = "󰔏 {temperatureC}°C";
          critical-threshold = 80;
          format-critical = "󱃂 {temperatureC}°C";
          on-click = "pypr toggle btop-popup";
        };
        
        # Native Bluetooth widget (replaces custom script)
        bluetooth = {
          format = "󰂯 {status}";
          format-connected = "󰂯 {num_connections}";
          format-disabled = "󰂲";
          on-click = "pypr toggle bluetuith-popup";
          tooltip-format = "{controller_alias}\t{controller_address}";
        };
        
        # Audio control scratchpad
        "custom/audio" = {
          format = "󰕾";
          tooltip-text = "Audio Control";
          on-click = "pypr toggle audio-popup";
        };
        
        # Keep native pulseaudio for scroll volume control
        pulseaudio = {
          format = "{icon}";
          format-muted = "󰝟";
          format-icons = {
            default = [ "󰕿" "󰖀" "󰕾" ];
          };
          on-click = "wpctl set-mute @DEFAULT_AUDIO_SINK@ toggle";
          on-scroll-up = "wpctl set-volume @DEFAULT_AUDIO_SINK@ 2%+";
          on-scroll-down = "wpctl set-volume @DEFAULT_AUDIO_SINK@ 2%-";
          states = {
            warning = 85;
          };
        };
        
        # Network management
        network = {
          format-wifi = "󰖩";
          format-ethernet = "󰈀";
          format-disconnected = "󰖪";
          on-click = "pypr toggle network-popup";
          tooltip-format-wifi = "{essid} ({signalStrength}%)";
          tooltip-format-ethernet = "{ipaddr}/{cidr}";
        };
        
        # System logs scratchpad
        "custom/logs" = {
          format = "󰌪";
          tooltip-text = "System Logs";
          on-click = "pypr toggle logs-popup";
        };
        
        # Notifications (simplified - no custom script)
        "custom/notification" = {
          format = "󰂚";
          tooltip-text = "Notifications";
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
      #cpu,
      #memory, 
      #temperature,
      #custom-system,
      #bluetooth,
      #custom-audio,
      #pulseaudio,
      #network,
      #custom-logs,
      #custom-notification,
      #clock {
        padding: 6px 8px;
        color: #868686;
        font-size: 10px;
        min-width: 24px;
      }
      
      /* System monitoring widgets */
      #cpu,
      #memory,
      #temperature {
        color: #7aa2f7;
        font-weight: 500;
      }
      
      /* Warning states */
      #cpu.warning,
      #memory.warning,
      #temperature.critical {
        color: #f7768e;
      }
      
      /* Clock styling */
      #clock {
        color: #c2c2c2;
        font-weight: 300;
        letter-spacing: 0.5px;
        min-width: 48px;
      }
      
      /* Hover effects for individual widgets */
      #cpu:hover,
      #memory:hover,
      #temperature:hover,
      #custom-system:hover,
      #bluetooth:hover,
      #custom-audio:hover,
      #pulseaudio:hover,
      #network:hover,
      #custom-logs:hover,
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
      
      #bluetooth.disabled {
        color: #5e5e5e;
      }
    '';
  };
}
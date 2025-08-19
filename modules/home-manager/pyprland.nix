# Pyprland configuration for scratchpad management
{ config, lib, pkgs, isDarwin ? false, ... }:

lib.mkIf (!isDarwin) {
  # Pyprland is only for Linux/Hyprland systems
  
  # Create pyprland config directory and file
  home.file.".config/pypr/pyprland.toml" = {
    text = ''
      [pyprland]
      
      [scratchpads]
      
      # System monitoring with btop
      [scratchpads.btop-popup]
      command = "ghostty --class=btop-popup --title='System Monitor' -e btop"
      class = "btop-popup"
      lazy = true
      animation = "fromTop" 
      margin = 50
      unfocus = "hide"
      size = "60% 70%"
      position = "20% 5%"
      
      # Bluetooth management  
      [scratchpads.bluetuith-popup]
      command = "ghostty --class=bluetuith-popup --title='Bluetooth Manager' -e bluetuith"
      class = "bluetuith-popup"
      lazy = true
      animation = "fromTop"
      margin = 50
      unfocus = "hide" 
      size = "50% 60%"
      position = "25% 10%"
      
      # Audio control with pulsemixer
      [scratchpads.audio-popup]
      command = "ghostty --class=audio-popup --title='Audio Control' -e pulsemixer"
      class = "audio-popup"
      lazy = true
      animation = "fromTop"
      margin = 50
      unfocus = "hide"
      size = "40% 50%"
      position = "30% 15%"
      
      # Network management with nmtui
      [scratchpads.network-popup]
      command = "ghostty --class=network-popup --title='Network Manager' -e nmtui"
      class = "network-popup"
      lazy = true
      animation = "fromTop"
      margin = 50
      unfocus = "hide"
      size = "50% 60%"
      position = "25% 10%"
      
      # System logs with lnav
      [scratchpads.logs-popup]
      command = "ghostty --class=logs-popup --title='System Logs' -e lnav"
      class = "logs-popup"
      lazy = true
      animation = "fromTop"
      margin = 50
      unfocus = "hide"
      size = "70% 80%"
      position = "15% 5%"
      
      # System management tools
      [scratchpads.system-popup]
      command = "ghostty --class=system-popup --title='System Management' -e systemctl-tui"
      class = "system-popup"
      lazy = true
      animation = "fromTop"
      margin = 50
      unfocus = "hide"
      size = "60% 70%"
      position = "20% 5%"
      
      # Additional monitoring tools
      [scratchpads.bandwidth-popup]
      command = "ghostty --class=bandwidth-popup --title='Network Bandwidth' -e bandwhich"
      class = "bandwidth-popup"
      lazy = true
      animation = "fromRight"
      margin = 50
      unfocus = "hide"
      size = "50% 60%"
      position = "45% 10%"
      
      [scratchpads.disk-popup]
      command = "ghostty --class=disk-popup --title='Disk I/O Monitor' -e iotop"
      class = "disk-popup"
      lazy = true
      animation = "fromRight"
      margin = 50
      unfocus = "hide"
      size = "60% 70%"
      position = "35% 5%"
    '';
  };
  
  # Install pyprland package (already added to system packages)
  # Add systemd user service for pyprland
  systemd.user.services.pyprland = {
    Unit = {
      Description = "Pyprland scratchpad manager";
      After = [ "hyprland-session.target" ];
      PartOf = [ "hyprland-session.target" ];
    };
    
    Service = {
      Type = "simple";
      ExecStart = "${pkgs.pyprland}/bin/pypr";
      Restart = "always";
      RestartSec = 3;
    };
    
    Install = {
      WantedBy = [ "hyprland-session.target" ];
    };
  };
}
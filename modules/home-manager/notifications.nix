{ config, pkgs, lib, ... }:

{
  services.mako = {
    enable = true;
    
    # Geometry - minimal, clean
    width = 320;
    height = 100;
    margin = "8";
    padding = "12";
    borderRadius = 4;
    
    # Behavior
    defaultTimeout = 5000;
    
    # Positioning
    anchor = "top-right";
    
    # Icon settings
    maxIconSize = 24;
    
    # Extra styling for specific notification types
    extraConfig = ''
      [urgency=low]
      background-color=#101010D0
      text-color=#868686
      border-color=#333333
      default-timeout=3000
      
      [urgency=normal]
      background-color=#101010E8
      text-color=#c2c2c2
      border-color=#333333
      default-timeout=5000
      
      [urgency=high]
      background-color=#101010F0
      text-color=#eeeeee
      border-color=#5e5e5e
      default-timeout=0
      
      [app-name="Volume"]
      format=<b>%s</b>\n%b
      default-timeout=2000
      group-by=category
      
      [app-name="Brightness"]
      format=<b>%s</b>\n%b
      default-timeout=2000
      group-by=category
    '';
  };
}
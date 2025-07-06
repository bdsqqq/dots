{ config, pkgs, lib, ... }:

{
  programs.fuzzel = {
    enable = true;
    
    settings = {
      main = {
        # Minimal config - let Stylix handle most styling
        width = 32;
        horizontal-pad = 16;
        vertical-pad = 12;
        inner-pad = 8;
        anchor = "center";
        border-width = 1;
        border-radius = 4;
        terminal = "ghostty";
      };
    };
  };
  
  # Create Screenshots directory
  home.file."Screenshots/.keep".text = "";
}
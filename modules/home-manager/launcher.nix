{ config, pkgs, lib, ... }:

{
  programs.fuzzel = {
    enable = true;
    
    settings = {
      main = {
        # Raycast-like centered positioning
        width = 60;
        lines = 10;
        horizontal-pad = 20;
        vertical-pad = 15;
        inner-pad = 10;
        anchor = "center";
        border-width = 0;
        border-radius = 8;
        terminal = "ghostty";
        # No icons for minimal look
        show-actions = false;
        # Font size for better readability
        font-size = 14;
        # Blur background
        layer = "overlay";
      };
    };
  };
  
  # Create Screenshots directory
  home.file."Screenshots/.keep".text = "";
  
  # Add Flatpak export paths to XDG data directories for application discovery
  home.sessionVariables = {
    XDG_DATA_DIRS = "$XDG_DATA_DIRS:$HOME/.local/share/flatpak/exports/share";
  };
}
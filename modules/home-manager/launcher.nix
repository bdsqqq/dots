{ config, pkgs, lib, isDarwin ? false, ... }:

lib.mkIf (!isDarwin) {
  
  # Create Screenshots directory
  home.file."Screenshots/.keep".text = "";
  
  # Add Flatpak export paths to XDG data directories for application discovery
  home.sessionVariables = {
    XDG_DATA_DIRS = "$XDG_DATA_DIRS:$HOME/.local/share/flatpak/exports/share";
  };
}
{ config, pkgs, lib, isDarwin ? false, ... }:

{
  # Disable stylix ghostty management - we handle it manually to work with homebrew
  stylix.targets.ghostty.enable = false;
  
  home.file.".config/ghostty/config" = {
    force = true;  # Always override existing config
    text = ''
      # Visual settings - user preferences
      font-family = "Berkeley Mono"
      macos-titlebar-style = "tabs"
      window-padding-x = 16
      window-padding-y = 0,4
      
      background = ${config.lib.stylix.colors.base00}
      foreground = ${config.lib.stylix.colors.base05}
      background-opacity = "0.6"
      background-blur = "8"
      selection-invert-fg-bg
      
      macos-icon = "custom-style"
      macos-icon-screen-color = ${config.lib.stylix.colors.base00}
      macos-icon-ghost-color = ${config.lib.stylix.colors.base05}
      
      keybind = shift+enter=text:\n
    '';  
  };
}
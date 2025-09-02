{ config, pkgs, lib, isDarwin ? false, ... }:

{
  # Disable stylix ghostty management - we handle it manually to work with homebrew
  stylix.targets.ghostty.enable = false;
  
  # Declarative ghostty config with stylix colors
  # Works for both nix-installed (Linux) and homebrew-installed (Darwin) ghostty
  home.file.".config/ghostty/config" = {
    force = true;  # Always override existing config
    text = ''
      # Visual settings - user preferences
      font-family = "Berkeley Mono"
      macos-titlebar-style = "tabs"
      window-padding-x = 16
      window-padding-y = 0,4
      
      # Stylix-based color scheme (e-ink theme)
      background = ${config.lib.stylix.colors.base00}
      foreground = ${config.lib.stylix.colors.base05}
      background-opacity = "0.6"
      background-blur = "16"
      selection-invert-fg-bg
      
      # macOS-specific icon settings with stylix colors
      macos-icon = "custom-style"
      macos-icon-screen-color = ${config.lib.stylix.colors.base00}
      macos-icon-ghost-color = ${config.lib.stylix.colors.base05}
      
      # Keybind
      keybind = shift+enter=text:\n
    '';
    
    # Ensure the file is recreated on every activation
    onChange = ''
      echo "Ghostty config updated with stylix colors"
    '';
  };
  
  # Note: Ghostty config is fully managed by home-manager with stylix integration
  # To switch themes, modify polarity in modules/shared/stylix.nix
}
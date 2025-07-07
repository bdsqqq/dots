{ config, pkgs, lib, isDarwin ? false, ... }:

{
  # For Darwin: Homebrew ghostty with manual stylix color integration
  # For Linux: Full stylix integration with nixpkgs ghostty
  stylix.targets.ghostty.enable = !isDarwin;  # Only enable for Linux
  
  # Manual ghostty config for Darwin (homebrew version) with stylix colors
  home.file.".config/ghostty/config" = lib.mkIf isDarwin {
    force = true;
    text = ''
      # Visual settings - your preferences
      font-family = "Berkeley Mono"
      macos-titlebar-style = "tabs"
      window-padding-x = 16
      window-padding-y = 0,4
      
      # Stylix-based color scheme (e-ink theme) - replaces manual colors
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
  };
  
  # Note: On Darwin, colors are manually set from stylix theme
  # On Linux, stylix handles ghostty automatically
  # To switch themes, modify polarity in modules/shared/stylix.nix
}
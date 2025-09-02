{ config, pkgs, lib, isDarwin ? false, ... }:

{
  # Declarative ghostty config
  # Works for both nix-installed (Linux) and homebrew-installed (Darwin) ghostty
  home.file.".config/ghostty/config" = {
    force = true;  # Always override existing config
    text = ''
      # Visual settings - user preferences
      font-family = "Berkeley Mono"
      macos-titlebar-style = "tabs"
      window-padding-x = 16
      window-padding-y = 0,4

      # Basic color scheme (can be overridden by stylix if available)
      background = "#1a1a1a"
      foreground = "#ffffff"

      # Keybind
      keybind = shift+enter=text:\n
    '';

    # Ensure the file is recreated on every activation
    onChange = ''
      echo "Ghostty config updated"
    '';
  };
}
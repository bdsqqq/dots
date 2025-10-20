{ lib, hostSystem ? null, ... }:

if !(lib.hasInfix "darwin" hostSystem) then {} else {
  homebrew = {
    enable = true;

    casks = [
      # System utilities
      "superwhisper"
      "blackhole-2ch"
      "cleanshot"
      "raycast"
      "bitwarden"

      # Development tools
      "orbstack"
      "tableplus"
      "ghostty"

      # Creative/Media tools
      "figma"
      "obs"

      # Productivity applications
      "1password"
      "1password-cli"
      "linear-linear"
      "notion-calendar"

      # Entertainment/Gaming
      "prismlauncher"
      "spotify"
      "steam"

      # Browsers
      "chromium"
    ];

    onActivation = {
      autoUpdate = true;
      cleanup = "zap";
    };
  };
}



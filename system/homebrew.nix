{ lib, hostSystem ? null, ... }:

if !(lib.hasInfix "darwin" hostSystem) then {} else {
  homebrew = {
    enable = true;

    casks = [
      # System utilities
      "superwhisper"
      "cleanshot"
      "raycast"

      # Development tools
      "orbstack"
      "tableplus"

      # Creative/Media tools
      "audacity"
      "figma"
      "obs"

      # Productivity applications
      "1password"
      "1password-cli"
      "linear-linear"
      "notion-calendar"
      "notion"

      # Entertainment/Gaming
      "spotify"
      "steam"
    ];

    onActivation = {
      autoUpdate = true;
      upgrade = true;
      cleanup = "uninstall";
    };
  };
}



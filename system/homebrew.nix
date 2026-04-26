{ lib, hostSystem ? null, ... }:

if !(lib.hasInfix "darwin" hostSystem) then
  { }
else {
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
      "t3-code"

      # Creative/Media tools
      "audacity"
      "blackhole-2ch"
      "figma"
      "obs"

      # Productivity applications
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


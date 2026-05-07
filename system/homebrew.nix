{ lib, hostSystem ? null, ... }:

if !(lib.hasInfix "darwin" hostSystem) then
  { }
else {
  environment.variables.HOMEBREW_NO_INSTALL_FROM_API = "1";

  homebrew = {
    enable = true;

    casks = [
      # System utilities
      "superwhisper"
      "cleanshot"
      "raycast"

      # Development tools
      "tableplus"
      "t3-code"

      # Creative/Media tools
      "audacity"
      "blackhole-2ch"
      "figma"
      "obs"

      # Productivity applications
      "linear"
      "notion-calendar"
      "notion"

      # Entertainment/Gaming
      "steam"
    ];

    onActivation = {
      autoUpdate = true;
      upgrade = true;
      cleanup = "uninstall";
    };
  };
}


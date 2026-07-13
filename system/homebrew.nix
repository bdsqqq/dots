{ config, lib, pkgs, hostSystem ? null, ... }:

if !(lib.hasInfix "darwin" hostSystem) then
  { }
else
  {
    homebrew = {
      enable = true;

      taps = [ "homebrew/cask" ];

      casks = [
        # System utilities
        "handy"
        "cleanshot"
        "tailscale-app"

        # Development tools
        "tableplus"

        # Creative/Media tools
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
        autoUpdate = false;
        upgrade = true;
      };
    };
  }

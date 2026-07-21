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
        "cleanshot"
        "tailscale-app"

        # Development tools
        "tableplus"

        # Creative/Media tools
        "figma"
        "obs"
        "transmission"

        # Productivity applications
        "linear"
        "vscodium"

        # Entertainment/Gaming
        "steam"
      ];

      onActivation = {
        autoUpdate = false;
        upgrade = true;
      };
    };
  }

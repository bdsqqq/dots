{ config, lib, pkgs, hostSystem ? null, ... }:

if !(lib.hasInfix "darwin" hostSystem) then
  { }
else
  {
    system.activationScripts.extraActivation.text = lib.mkAfter ''
      mkdir -p /usr/local/bin
      ln -sfn "/Applications/cmux.app/Contents/Resources/bin/cmux" /usr/local/bin/cmux
    '';

    homebrew = {
      enable = true;

      taps = [
        "homebrew/cask"
        "manaflow-ai/cmux"
      ];

      casks = [
        # System utilities
        "handy"
        "cleanshot"
        "cmux"
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

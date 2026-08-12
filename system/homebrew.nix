{ config, lib, pkgs, hostSystem ? null, ... }:

if !(lib.hasInfix "darwin" hostSystem) then
  { }
else
  {
    homebrew = {
      enable = true;
      onActivation = {
        autoUpdate = false;
        upgrade = true;
      };
    };
  }

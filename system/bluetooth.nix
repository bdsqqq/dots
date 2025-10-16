{ lib, pkgs, ... }:
{
  # Linux-only: define the entire subtree conditionally so darwin never sees the option
  services = lib.optionalAttrs pkgs.stdenv.isLinux {
    blueman.enable = true;
  };
}



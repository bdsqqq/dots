{ lib, config, pkgs, ... }:
{
  imports = [
    (if pkgs.stdenv.isLinux then ../system/syncthing-linux.nix else ../system/syncthing-darwin.nix)
  ];
}



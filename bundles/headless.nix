{ lib, config, pkgs, ... }:
{
  imports = [
    ../system/syncthing-linux.nix
    ../system/syncthing-darwin.nix
  ];
}



{ lib, config, pkgs, ... }:
{
  services.syncthing = {
    enable = true;
    user = "bdsqqq";
    dataDir = if pkgs.stdenv.isDarwin then "/Users/bdsqqq" else "/home/bdsqqq";
    configDir = if pkgs.stdenv.isDarwin then "/Users/bdsqqq/.config/syncthing" else "/home/bdsqqq/.config/syncthing";
  };
}



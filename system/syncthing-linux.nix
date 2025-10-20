{ lib, pkgs, ... }:
lib.optionalAttrs pkgs.stdenv.isLinux {
  services.syncthing = {
    enable = true;
    user = "bdsqqq";
    dataDir = "/home/bdsqqq";
    configDir = "/home/bdsqqq/.config/syncthing";
  };
}

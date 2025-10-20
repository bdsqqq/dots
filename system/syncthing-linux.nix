{ lib, pkgs, ... }:
if !pkgs.stdenv.isLinux then {} else {
  services.syncthing = {
    enable = true;
    user = "bdsqqq";
    dataDir = "/home/bdsqqq";
    configDir = "/home/bdsqqq/.config/syncthing";
  };
}

{ lib, config, hostSystem ? null, ... }:

if !(lib.hasInfix "linux" hostSystem) then {} else {
  system.autoUpgrade = {
    enable = lib.mkDefault true;
    flake = lib.mkDefault "github:bdsqqq/dots#${config.networking.hostName}";
    dates = lib.mkDefault "hourly";
    allowReboot = lib.mkDefault false;
    flags = [ "--refresh" ];
  };
}

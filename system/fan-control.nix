{ lib, pkgs, hostSystem ? null, ... }:

if !(lib.hasInfix "linux" hostSystem) then {} else {
  boot.kernelModules = [ "nct6683" ];
  
  environment.systemPackages = with pkgs; [
    lm_sensors
  ];
}

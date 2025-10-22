{ lib, hostSystem ? null, ... }:

if !(lib.hasInfix "linux" hostSystem) then {} else {
  services.blueman.enable = true;
  hardware.bluetooth = {
    enable = true;
    powerOnBoot = true;
  };
}



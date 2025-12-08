{ lib, hostSystem ? null, ... }:

if !(lib.hasInfix "linux" hostSystem) then {} else {
  services.blueman.enable = true;
  hardware.bluetooth = {
    enable = true;
    powerOnBoot = true;
    settings = {
      General = {
        Experimental = true;
        ClassicBondedOnly = false;
      };
    };
  };
  
  boot.kernelModules = [ "hid_playstation" ];
}



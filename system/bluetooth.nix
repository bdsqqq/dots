{ lib, hostSystem ? null, ... }:

let
  isLinuxHost = hostSystem == null || lib.hasInfix "linux" hostSystem;
in
lib.mkIf isLinuxHost {
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



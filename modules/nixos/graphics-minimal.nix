# Minimal graphics configuration for NVIDIA
{ config, pkgs, lib, ... }:

{
  services.xserver.videoDrivers = [ "nvidia" ];
  
  hardware.nvidia = {
    package = config.boot.kernelPackages.nvidiaPackages.stable;
    modesetting.enable = true;
    open = true;  # RTX 3060 supports open source drivers
  };

  hardware.graphics.enable = true;
}
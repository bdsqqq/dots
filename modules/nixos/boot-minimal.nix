# Minimal boot configuration for NixOS
{ config, pkgs, lib, ... }:

{
  boot = {
    loader = {
      systemd-boot.enable = true;
      systemd-boot.configurationLimit = 2; # Only keep 2 generations to save space
      efi.canTouchEfiVariables = true;
      efi.efiSysMountPoint = "/boot";
    };
    
    kernelPackages = pkgs.linuxPackages_latest;
    kernelModules = [ "kvm-amd" "nvidia" "nvidia_modeset" "nvidia_uvm" "nvidia_drm" ];
    blacklistedKernelModules = [ "nouveau" ];
  };
}
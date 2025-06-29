# Graphics configuration for Windows PC
# NVIDIA GeForce RTX 3060 + AMD Radeon integrated graphics
{ config, pkgs, lib, ... }:

{
  # NVIDIA configuration
  services.xserver.videoDrivers = [ "nvidia" ];
  
  hardware.nvidia = {
    package = config.boot.kernelPackages.nvidiaPackages.production;
    modesetting.enable = true;
    powerManagement.enable = false;
    nvidiaSettings = true;
    open = true;  # Required for driver >= 560, RTX 3060 supports it
  };

  # Graphics hardware acceleration
  hardware.graphics = {
    enable = true;
    enable32Bit = true;
  };

  # Environment variables for NVIDIA + Wayland
  environment.sessionVariables = {
    LIBVA_DRIVER_NAME = "nvidia";
    GBM_BACKEND = "nvidia-drm";
    __GLX_VENDOR_LIBRARY_NAME = "nvidia";
    WLR_NO_HARDWARE_CURSORS = "1";
  };

  # Additional packages for GPU monitoring
  environment.systemPackages = with pkgs; [
    nvidia-smi
    nvtop
  ];
}
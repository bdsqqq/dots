{ lib, config, pkgs, ... }:
{
  # NVIDIA graphics setup (Linux only)
  services.xserver.videoDrivers = lib.mkIf pkgs.stdenv.isLinux [ "nvidia" ];

  hardware.nvidia = lib.mkIf pkgs.stdenv.isLinux {
    package = config.boot.kernelPackages.nvidiaPackages.production;
    modesetting.enable = true;
    powerManagement.enable = false;
    nvidiaSettings = true;
    open = true;
  };

  hardware.graphics = lib.mkIf pkgs.stdenv.isLinux {
    enable = true;
    enable32Bit = true;
  };

  environment.sessionVariables = lib.mkIf pkgs.stdenv.isLinux {
    LIBVA_DRIVER_NAME = "nvidia";
    GBM_BACKEND = "nvidia-drm";
    __GLX_VENDOR_LIBRARY_NAME = "nvidia";
    WLR_NO_HARDWARE_CURSORS = "1";
  };

  environment.systemPackages = lib.mkIf pkgs.stdenv.isLinux (with pkgs; [
    nvtopPackages.nvidia
  ]);
}



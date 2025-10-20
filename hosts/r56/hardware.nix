{ config, lib, pkgs, modulesPath, ... }:

{
  imports = [ (modulesPath + "/installer/scan/not-detected.nix") ];

  boot.initrd.availableKernelModules = [ "xhci_pci" "ahci" "nvme" "usbhid" "sd_mod" ];
  boot.initrd.kernelModules = [ ];
  boot.kernelModules = [ "kvm-amd" ];
  boot.extraModulePackages = [ ];

  boot.kernelParams = [ "nvidia-drm.modeset=1" ];
  boot.blacklistedKernelModules = [ "nouveau" ];

  fileSystems."/" = {
    device = "/dev/disk/by-uuid/3deeb152-c556-4483-ac8b-c063b46065b7";
    fsType = "ext4";
  };

  fileSystems."/boot" = {
    device = "/dev/disk/by-uuid/58F5-055B";
    fsType = "vfat";
    options = [ "fmask=0077" "dmask=0077" ];
  };

  fileSystems."/mnt/ssd" = {
    device = "/dev/disk/by-uuid/32794d46-d4a7-458b-ae80-cec556733579";
    fsType = "ext4";
    options = [ "defaults" ];
  };

  swapDevices = [
    { device = "/dev/disk/by-uuid/46c2bd54-4bf5-4e24-b059-bded425c02b9"; }
  ];

  boot.loader = {
    systemd-boot.enable = true;
    efi.canTouchEfiVariables = true;
  };

  hardware = {
    enableRedistributableFirmware = true;
    enableAllFirmware = true;
    cpu.amd.updateMicrocode = lib.mkDefault config.hardware.enableRedistributableFirmware;
    graphics = {
      enable = true;
      enable32Bit = true;
      extraPackages = with pkgs; [
        nvidia-vaapi-driver
        vaapiVdpau
        libvdpau-va-gl
      ];
    };
    nvidia = {
      modesetting.enable = lib.mkForce true;
      powerManagement.enable = lib.mkForce true;
      powerManagement.finegrained = lib.mkForce false;
      open = lib.mkForce false;
      nvidiaSettings = lib.mkForce true;
      package = lib.mkForce config.boot.kernelPackages.nvidiaPackages.stable;
    };
  };

  nixpkgs.hostPlatform = lib.mkDefault "x86_64-linux";
}

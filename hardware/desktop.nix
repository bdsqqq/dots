# Hardware configuration for NixOS desktop
# Generated from nixos-generate-config output
{ config, lib, pkgs, modulesPath, ... }:

{
  imports = [ (modulesPath + "/installer/scan/not-detected.nix") ];

  # Boot configuration
  boot.initrd.availableKernelModules = [ "xhci_pci" "ahci" "nvme" "usbhid" "sd_mod" ];
  boot.initrd.kernelModules = [ ];
  boot.kernelModules = [ "kvm-amd" ];
  boot.extraModulePackages = [ ];

  # File systems
  fileSystems."/" = {
    device = "/dev/disk/by-uuid/3deeb152-c556-4483-ac8b-c063b46065b7";
    fsType = "ext4";
  };

  fileSystems."/boot" = {
    device = "/dev/disk/by-uuid/58F5-055B";
    fsType = "vfat";
    options = [ "fmask=0077" "dmask=0077" ];
  };

  # Swap
  swapDevices = [
    { device = "/dev/disk/by-uuid/46c2bd54-4bf5-4e24-b059-bded425c02b9"; }
  ];

  # Networking
  networking.useDHCP = lib.mkDefault true;

  # Platform
  nixpkgs.hostPlatform = lib.mkDefault "x86_64-linux";

  # Hardware-specific settings
  hardware = {
    # Enable all firmware
    enableRedistributableFirmware = true;
    enableAllFirmware = true;
    
    # CPU microcode updates
    cpu.amd.updateMicrocode = lib.mkDefault config.hardware.enableRedistributableFirmware;
    
    # Graphics configuration
    graphics = {
      enable = true;
      enable32Bit = true;
    };
    
    # Bluetooth support
    bluetooth = {
      enable = true;
      powerOnBoot = true;
    };
  };

  # Power management
  powerManagement = {
    enable = true;
    cpuFreqGovernor = "ondemand";
  };

  # Services for hardware
  services = {
    # Enable fstrim for SSD maintenance
    fstrim.enable = true;
    
    # Hardware monitoring
    smartd.enable = true;
    
    # Thermal management
    thermald.enable = true;
  };
}
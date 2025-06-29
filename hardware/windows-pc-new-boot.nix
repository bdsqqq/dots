# Hardware configuration for Windows PC with SATA boot
# This assumes you've created /dev/sda4 as the new EFI partition

{ config, lib, pkgs, modulesPath, ... }:

{
  imports = [ (modulesPath + "/installer/scan/not-detected.nix") ];

  # Boot configuration is handled in modules/nixos/boot.nix

  # File systems with new boot partition
  fileSystems = {
    "/" = {
      device = "/dev/disk/by-uuid/145260f4-1e30-4447-bd6c-2d2e373de10f";
      fsType = "ext4";
    };

    "/boot" = {
      device = "/dev/sda4";  # New EFI partition on SATA
      fsType = "vfat";
    };
  };

  # No swap configured
  swapDevices = [ ];

  # Hardware-specific settings
  hardware = {
    # Enable all firmware
    enableRedistributableFirmware = true;
    enableAllFirmware = true;
    
    # CPU microcode updates
    cpu.amd.updateMicrocode = true;
    
    # Graphics configuration
    graphics = {
      enable = true;
      enable32Bit = true;
      extraPackages = with pkgs; [
        # AMD integrated graphics support
        amdvlk
        mesa
        # VAAPI support
        libvdpau-va-gl
        vaapiVdpau
      ];
      extraPackages32 = with pkgs.pkgsi686Linux; [
        amdvlk
      ];
    };
    
    # Bluetooth support
    bluetooth = {
      enable = true;
      powerOnBoot = true;
    };
    
    # Audio support - moved to services
  };

  # Networking
  networking = {
    useDHCP = lib.mkDefault true;
    # NetworkManager will handle the ethernet connection
    networkmanager.enable = true;
  };

  # Platform
  nixpkgs.hostPlatform = lib.mkDefault "x86_64-linux";

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
    
    # Audio support
    pulseaudio.enable = false; # Using PipeWire instead
  };
}
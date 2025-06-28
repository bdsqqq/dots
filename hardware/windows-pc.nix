# Hardware configuration for Windows PC
# CPU: AMD Ryzen 5 5600G
# GPU: NVIDIA GeForce RTX 3060 + AMD Radeon(TM) Graphics (integrated)
# RAM: 16GB
# Storage: 256GB SSD (C:) + 1TB HDD (D:)
# Display: LG HDR 4K 3840x2160 @ 60Hz

{ config, lib, pkgs, modulesPath, ... }:

{
  imports = [ (modulesPath + "/installer/scan/not-detected.nix") ];

  # Boot configuration
  boot = {
    initrd = {
      availableKernelModules = [ 
        "nvme" "xhci_pci" "ahci" "usbhid" "usb_storage" "sd_mod" 
        "rtsx_pci_sdmmc" 
      ];
      kernelModules = [ ];
    };
    
    kernelModules = [ "kvm-amd" ];
    extraModulePackages = [ ];
    
    # Use stable kernel for compatibility
    kernelPackages = pkgs.linuxPackages_6_6;
    
    # Enable IOMMU for AMD
    kernelParams = [
      "amd_iommu=on"
      "iommu=pt"
      # Quiet boot
      "quiet"
      "splash"
      # NVIDIA-related parameters
      "nvidia-drm.modeset=1"
      "nvidia.NVreg_PreserveVideoMemoryAllocations=1"
    ];
  };

  # File systems (template - will need actual UUIDs after installation)
  fileSystems = {
    "/" = {
      device = "/dev/disk/by-uuid/ROOT-UUID-HERE";
      fsType = "ext4";
    };

    "/boot" = {
      device = "/dev/disk/by-uuid/BOOT-UUID-HERE";
      fsType = "vfat";
    };

    # Optional: mount point for the 1TB HDD
    "/mnt/storage" = {
      device = "/dev/disk/by-uuid/STORAGE-UUID-HERE";
      fsType = "ext4";
      options = [ "defaults" "user" "rw" ];
    };
  };

  # Swap configuration
  swapDevices = [
    {
      device = "/dev/disk/by-uuid/SWAP-UUID-HERE";
    }
  ];

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
        mesa.drivers
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
    
    # Audio support
    pulseaudio.enable = false; # Using PipeWire instead
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
  };
}
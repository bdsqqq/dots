# VM Hardware Configuration
{ config, lib, pkgs, modulesPath, ... }:

{
  imports = [ (modulesPath + "/profiles/qemu-guest.nix") ];

  # VM-optimized hardware configuration
  boot = {
    initrd = {
      availableKernelModules = [ "ahci" "xhci_pci" "virtio_pci" "sr_mod" "virtio_blk" ];
      kernelModules = [ ];
    };
    kernelModules = [ "kvm-intel" ];
    extraModulePackages = [ ];
    
    # Use systemd-boot for UEFI VMs
    loader = {
      systemd-boot.enable = true;
      efi.canTouchEfiVariables = true;
    };
  };

  # VM disk configuration
  fileSystems = {
    "/" = {
      device = "/dev/disk/by-label/nixos";
      fsType = "ext4";
    };
    "/boot" = {
      device = "/dev/disk/by-label/boot";
      fsType = "vfat";
    };
  };

  swapDevices = [ ];

  # VM networking
  networking = {
    useDHCP = lib.mkDefault true;
    interfaces = {
      enp1s0.useDHCP = lib.mkDefault true;
    };
  };

  # Hardware acceleration for VMs
  hardware = {
    graphics = {
      enable = true;
      enable32Bit = true;
    };
  };

  # VM-specific optimizations
  services = {
    qemuGuest.enable = true;
    spice-vdagentd.enable = true;
  };

  # Enable KVM nested virtualization if needed
  boot.extraModprobeConfig = "options kvm_intel nested=1";

  nixpkgs.hostPlatform = lib.mkDefault "x86_64-linux";
}

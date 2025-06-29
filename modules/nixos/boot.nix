# Boot configuration for dual-boot Windows 11 + NixOS
{ config, pkgs, lib, ... }:

{
  boot = {
    # Use GRUB for dual-boot support with Windows
    loader = {
      # Disable systemd-boot (conflicts with GRUB)
      systemd-boot.enable = false;
      
      # GRUB configuration for dual-boot
      grub = {
        enable = true;
        device = "nodev";  # Use UEFI, no MBR
        efiSupport = true;
        efiInstallAsRemovable = false;
        useOSProber = true;  # Automatically detect Windows
        
        # GRUB theme and appearance
        theme = pkgs.nixos-grub2-theme;
        splashImage = null;  # Use theme background
        
        # Timeout for boot menu
        timeout = 10;
        
        # Default boot entry (0 = first entry, usually NixOS)
        default = 0;
        
        # Additional entries can be configured here
        extraEntries = ''
          # Windows entry will be auto-detected by os-prober
          # Manual entry example (if os-prober fails):
          # menuentry "Windows 11" {
          #   search --set=root --fs-uuid WINDOWS-EFI-UUID
          #   chainloader /EFI/Microsoft/Boot/bootmgfw.efi
          # }
        '';
        
        # GRUB configuration options
        extraConfig = ''
          # Set graphics mode for GRUB
          set gfxmode=auto
          insmod gfxterm
          insmod vbe
          insmod vga
          
          # Enable os-prober
          GRUB_DISABLE_OS_PROBER=false
        '';
      };
      
      # EFI variables
      efi = {
        canTouchEfiVariables = true;
        efiSysMountPoint = "/boot";
      };
    };
    
    # Kernel parameters
    kernelParams = [
      # Quiet boot
      "quiet" 
      "splash"
      
      # NVIDIA specific
      "nvidia-drm.modeset=1"
      "nvidia.NVreg_PreserveVideoMemoryAllocations=1"
      
      # AMD CPU optimizations
      "amd_pstate=guided"
      
      # Security
      "mitigations=auto"
      
      # Better performance for desktop
      "preempt=voluntary"
    ];
    
    # Use stable kernel for compatibility
    kernelPackages = pkgs.linuxPackages_6_6;
    
    # Additional kernel modules
    kernelModules = [ 
      "kvm-amd"      # Virtualization support
      "nvidia"       # NVIDIA driver
      "nvidia_drm"   # NVIDIA DRM
      "nvidia_modeset"
    ];
    
    # Early kernel modules
    initrd = {
      availableKernelModules = [
        "nvme"           # NVMe SSD support
        "xhci_pci"       # USB 3.0
        "ahci"           # SATA
        "usbhid"         # USB input devices
        "usb_storage"    # USB storage
        "sd_mod"         # SCSI disk support
        "rtsx_pci_sdmmc" # SD card reader
      ];
      
      kernelModules = [
        "nvidia"
        "nvidia_modeset" 
        "nvidia_uvm"
        "nvidia_drm"
      ];
      
      # Enable systemd in initrd for better boot experience
      systemd.enable = true;
    };
    
    # Blacklist conflicting drivers
    blacklistedKernelModules = [ 
      "nouveau"  # Conflicts with NVIDIA proprietary
    ];
    
    # Boot optimization
    tmp = {
      useTmpfs = true;
      tmpfsSize = "50%";  # Use up to 50% of RAM for /tmp
    };
  };

  # File system optimization for dual-boot
  fileSystems = {
    # Optimize mount options for SSDs
    "/" = {
      options = [ 
        "noatime"      # Don't update access times
        "discard"      # Enable TRIM for SSD
        "errors=remount-ro" 
      ];
    };
    
    "/boot" = {
      options = [ 
        "defaults"
        "umask=077"    # Secure boot partition
      ];
    };
  };

  # Services for boot optimization
  services = {
    # Enable fstrim for SSD maintenance
    fstrim = {
      enable = true;
      interval = "weekly";
    };
    
    # Firmware updates
    fwupd.enable = true;
    
    # Hardware detection and management
    udev.enable = true;
    udisks2.enable = true;  # For removable media
  };

  # System packages for boot management
  environment.systemPackages = with pkgs; [
    # Boot management tools
    efibootmgr      # EFI boot manager
    grub2           # GRUB utilities
    os-prober       # OS detection for dual-boot
    
    # File system tools
    ntfs3g          # NTFS support for Windows partitions
    exfat           # exFAT support
    
    # Partition management
    gparted         # GUI partition editor
    parted          # Command-line partition editor
    
    # System information
    lshw            # Hardware information
    hwinfo          # Detailed hardware info
    smartmontools   # Hard drive monitoring
  ];

  # Enable NTFS support for accessing Windows partitions
  boot.supportedFilesystems = [ "ntfs" "exfat" ];

  # Security considerations for dual-boot
  # Note: mount wrapper removed due to conflicts
}
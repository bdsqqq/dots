# Simple NixOS desktop configuration
{ pkgs, inputs, lib, config, modulesPath, ... }:

{
  imports = [
    (modulesPath + "/installer/scan/not-detected.nix")
    ../../modules/shared/default.nix
  ];

  # Hardware configuration (inline)
  boot.initrd.availableKernelModules = [ "xhci_pci" "ahci" "nvme" "usbhid" "sd_mod" ];
  boot.initrd.kernelModules = [ ];
  boot.kernelModules = [ "kvm-amd" ];
  boot.extraModulePackages = [ ];
  
  # NVIDIA kernel modules
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

  swapDevices = [
    { device = "/dev/disk/by-uuid/46c2bd54-4bf5-4e24-b059-bded425c02b9"; }
  ];

  # Boot configuration
  boot.loader = {
    systemd-boot.enable = true;
    efi.canTouchEfiVariables = true;
  };

  # Basic system settings
  networking.hostName = "desktop";
  networking.networkmanager.enable = true;
  networking.useDHCP = lib.mkDefault true;
  
  time.timeZone = "America/New_York";
  i18n.defaultLocale = "en_US.UTF-8";

  # Hardware
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
      modesetting.enable = true;
      powerManagement.enable = true;
      powerManagement.finegrained = false;
      open = false;
      nvidiaSettings = true;
      package = config.boot.kernelPackages.nvidiaPackages.stable;
    };
    bluetooth = {
      enable = true;
      powerOnBoot = true;
    };
  };

  # Enable niri window manager
  programs.niri.enable = true;

  # Display manager
  services.greetd = {
    enable = true;
    settings.default_session = {
      command = "${pkgs.greetd.tuigreet}/bin/tuigreet --cmd niri-session";
      user = "greeter";
    };
  };

  # Audio with PipeWire
  services.pipewire = {
    enable = true;
    alsa.enable = true;
    alsa.support32Bit = true;
    pulse.enable = true;
    jack.enable = true;
  };

  # Security
  security.rtkit.enable = true;
  
  # Enable dconf for theme settings
  programs.dconf.enable = true;
  
  # X server configuration (needed for Steam and some applications)
  services.xserver = {
    enable = true;
    videoDrivers = [ "nvidia" ];
    displayManager.startx.enable = true;
  };

  # Your user
  users.users.bdsqqq = {
    isNormalUser = true;
    extraGroups = [ "wheel" "networkmanager" "audio" "video" ];
    shell = pkgs.zsh;
  };

  # Enable zsh
  programs.zsh.enable = true;

  # Home-manager setup
  home-manager = {
    useGlobalPkgs = true;
    useUserPackages = true;
    
    users.bdsqqq = {
      imports = [
        inputs.nixvim.homeManagerModules.nixvim
        inputs.sops-nix.homeManagerModules.sops
        ../../modules/home-manager/default.nix
        ../../modules/home-manager/profiles/niri.nix
      ];
    };
    
    extraSpecialArgs = { 
      inherit inputs; 
      isDarwin = false;
    };
  };

  # Additional system packages specific to desktop
  environment.systemPackages = with pkgs; [
    # Network tools
    networkmanagerapplet
    
    # File manager
    nautilus
    
    # Additional desktop tools
    tree
    unzip
    
    # Theme tools
    dconf
    gsettings-desktop-schemas
    
    # Graphics and gaming support
    vulkan-tools
    vulkan-loader
    vulkan-validation-layers
    mesa
    
    # Display management
    wdisplays  # Wayland display configurator
    wlr-randr  # Command-line display management for wlroots
  ];

  # Enable unfree packages
  nixpkgs.config.allowUnfree = true;
  nixpkgs.hostPlatform = lib.mkDefault "x86_64-linux";

  # Set dark theme system-wide and NVIDIA variables
  environment.sessionVariables = {
    # Force dark theme for GTK applications
    GTK_THEME = "Adwaita:dark";
    # Set color scheme preference
    COLOR_SCHEME = "prefer-dark";
    # NVIDIA Wayland support
    LIBVA_DRIVER_NAME = "nvidia";
    XDG_SESSION_TYPE = "wayland";
    GBM_BACKEND = "nvidia-drm";
    __GLX_VENDOR_LIBRARY_NAME = "nvidia";
    WLR_NO_HARDWARE_CURSORS = "1";
    # X11 display for applications that need it
    DISPLAY = ":0";
  };
  
  # Automatic garbage collection
  nix.gc = {
    automatic = true;
    dates = "weekly";
    options = "--delete-older-than 30d";
  };

  # System state version
  system.stateVersion = "25.05";
}

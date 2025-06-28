# Graphics configuration for Windows PC
# NVIDIA GeForce RTX 3060 + AMD Radeon integrated graphics
{ config, pkgs, lib, ... }:

{
  # Enable unfree packages for NVIDIA drivers
  nixpkgs.config.allowUnfree = true;

  # NVIDIA configuration
  services.xserver.videoDrivers = [ "nvidia" ];
  
  hardware.nvidia = {
    # Use the production branch drivers
    # For newer kernels, you might need to use open source drivers
    package = config.boot.kernelPackages.nvidiaPackages.production;
    
    # Enable modesetting (required for Wayland)
    modesetting.enable = true;
    
    # Power management (experimental)
    powerManagement = {
      enable = true;
      # Fine-grained power management (for mobile GPUs, disable for desktop)
      finegrained = false;
    };
    
    # Enable nvidia-settings
    nvidiaSettings = true;
    
    # Optionally use open source kernel modules (not recommended for stability yet)
    open = false;
  };

  # Graphics hardware acceleration
  hardware.graphics = {
    enable = true;
    enable32Bit = true;
    
    extraPackages = with pkgs; [
      # NVIDIA packages
      nvidia-vaapi-driver
      libvdpau-va-gl
      
      # AMD packages (for integrated graphics)
      amdvlk
      mesa.drivers
      
      # General video acceleration
      vaapiVdpau
      intel-vaapi-driver # Sometimes needed for compatibility
    ];
    
    extraPackages32 = with pkgs.pkgsi686Linux; [
      amdvlk
      mesa.drivers
    ];
  };

  # Environment variables for NVIDIA + Wayland
  environment.sessionVariables = {
    # Enable NVIDIA support in Wayland
    LIBVA_DRIVER_NAME = "nvidia";
    XDG_SESSION_TYPE = "wayland";
    GBM_BACKEND = "nvidia-drm";
    __GLX_VENDOR_LIBRARY_NAME = "nvidia";
    
    # Enable Wayland in applications
    NIXOS_OZONE_WL = "1";  # Chromium/Electron apps
    MOZ_ENABLE_WAYLAND = "1";  # Firefox
    
    # NVIDIA-specific Wayland flags
    WLR_NO_HARDWARE_CURSORS = "1";  # Fixes cursor issues in some Wayland compositors
    
    # DRM device selection (prefer NVIDIA for rendering)
    WLR_DRM_DEVICES = "/dev/dri/card0:/dev/dri/card1";
  };

  # Kernel modules
  boot = {
    kernelModules = [ "nvidia" "nvidia_modeset" "nvidia_uvm" "nvidia_drm" ];
    
    # Blacklist nouveau (open source NVIDIA driver)
    blacklistedKernelModules = [ "nouveau" ];
    
    # Early loading of NVIDIA modules
    initrd.kernelModules = [ "nvidia" "nvidia_modeset" "nvidia_uvm" "nvidia_drm" ];
  };

  # NVIDIA container support (if using Docker with GPU)
  virtualisation.docker.enableNvidia = true;

  # Additional packages for GPU monitoring and control
  environment.systemPackages = with pkgs; [
    # NVIDIA tools
    nvidia-smi
    nvtop          # GPU process monitor
    
    # GPU info tools
    glxinfo
    vulkan-tools
    mesa-demos
    
    # Video encoding/decoding tools
    ffmpeg-full
    
    # GPU benchmarking (optional)
    # unigine-heaven
    # unigine-valley
  ];

  # Services for optimal GPU performance
  services = {
    # Enable hardware video acceleration
    # hardware.bolt.enable = true;  # Thunderbolt support (enable if needed)
    
    # GPU switching (if using hybrid graphics)
    # optionally enable switcheroo-control for GPU switching
    # switcheroo-control.enable = false;  # Disable for desktop with discrete GPU
  };

  # Systemd services for NVIDIA
  systemd.services.nvidia-control-devices = {
    wantedBy = [ "multi-user.target" ];
    serviceConfig.ExecStart = "${pkgs.linuxPackages.nvidia_x11.bin}/bin/nvidia-smi";
  };
}
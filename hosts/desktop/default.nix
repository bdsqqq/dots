{ pkgs, inputs, lib, config, modulesPath, ... }:

{
  imports = [
    (modulesPath + "/installer/scan/not-detected.nix")
    ../../modules/shared/default.nix
  ];

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

  networking.hostName = "r56";
  networking.networkmanager.enable = true;
  networking.useDHCP = lib.mkDefault true;
  
  time.timeZone = "Europe/London";
  i18n.defaultLocale = "en_US.UTF-8";

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

  programs.hyprland.enable = true;
  services.tailscale.enable = true;
  
  # Enable Kanata for homerow mods and layers
  services.kanata = {
    enable = true;
    keyboards.default = {
      devices = [
        # Apply to all USB keyboards EXCEPT Corne and Moonlander
        "/dev/input/by-id/usb-*-kbd"
      ];
      # Exclude specific keyboards by device name patterns
      extraDefCfg = ''
        linux-dev-names-exclude (
          "Corne Choc Pro"
          "Moonlander Mark I"
        )
      '';
      configFile = ../../modules/shared/kanata.kbd;
    };
  };
  
  # Enable Syncthing
  services.syncthing = {
    enable = true;
    user = "bdsqqq";
    dataDir = "/home/bdsqqq";
    configDir = "/home/bdsqqq/.config/syncthing";
    openDefaultPorts = true;
    guiAddress = "0.0.0.0:8384";
    settings = {
      gui = {
        user = "bdsqqq";
        insecureAdminAccess = false;
      };
      options = {
        urAccepted = -1;  # Disable usage reporting
        globalAnnounceEnabled = false;  # Use only local discovery with Tailscale
        localAnnounceEnabled = true;
        relaysEnabled = false;  # Don't use public relays, use Tailscale
        # Disable NAT traversal - use Tailscale instead
        natEnabled = false;
        upnpEnabled = false;
        # Only listen on Tailscale interface
        listenAddress = "tcp://100.94.68.111:22000";
      };
      
      # Define devices declaratively so they persist across rebuilds
      devices = {
        "mbp14" = {
          id = "BQRNC7S-3O6EQPK-5ZEDX6Q-KUSMJHQ-6HXJHYY-AHDBJNO-4C27WBW-XG6CCQR";
          introducer = true;
          autoAcceptFolders = false;
          addresses = [ "tcp://100.87.59.2:22000" "quic://100.87.59.2:22000" ];
        };
        "iph16" = {
          id = "L2PJ4F3-BZUZ4RX-3BCPIYB-V544M22-P3WDZBF-ZEVYT5A-GPTX5ZF-ZM5KTQK";
          introducer = false;
          addresses = [ "tcp://100.123.116.27:22000" "quic://100.123.116.27:22000" ];
        };
      };
      
      # Folders will be manually configured through GUI to choose proper paths
      folders = { };
    };
  };
  
  # Enable Flatpak
  services.flatpak.enable = true;
  
  # Bluetooth management
  services.blueman.enable = true;

  # Display manager
  services.greetd = {
    enable = true;
    settings.default_session = {
      command = "${pkgs.greetd.tuigreet}/bin/tuigreet --cmd Hyprland";
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
    
    # WirePlumber configuration for default HDMI audio
    wireplumber = {
      enable = true;
      configPackages = [
        (pkgs.writeTextDir "share/wireplumber/wireplumber.conf.d/51-hdmi-default.conf" ''
          monitor.alsa.rules = [
            {
              matches = [
                {
                  device.name = "~alsa_card.pci-0000_*_00.1"
                }
              ]
              actions = {
                update-props = {
                  api.alsa.use-acp = true
                  device.profile.switch = true
                  device.profile = "output:hdmi-stereo"
                }
              }
            }
          ]
        '')
      ];
    };
  };

  # Security
  security.rtkit.enable = true;
  
  # Enable SSH
  services.openssh = {
    enable = true;
    settings = {
      PasswordAuthentication = true;
      PermitRootLogin = "no";
    };
  };
  
  # Enable dconf for theme settings
  programs.dconf.enable = true;
  
  # Udev rules for DualSense controller support
  services.udev.extraRules = ''
    # DualSense PS5 controller - Bluetooth
    KERNEL=="hidraw*", KERNELS=="*054C:0CE6*", MODE="0660", TAG+="uaccess"
    # DualSense PS5 controller - USB  
    KERNEL=="hidraw*", ATTRS{idVendor}=="054c", ATTRS{idProduct}=="0ce6", MODE="0660", TAG+="uaccess"
    # DualSense Edge PS5 controller - Bluetooth
    KERNEL=="hidraw*", KERNELS=="*054C:0DF2*", MODE="0660", TAG+="uaccess"
    # DualSense Edge PS5 controller - USB
    KERNEL=="hidraw*", ATTRS{idVendor}=="054c", ATTRS{idProduct}=="0df2", MODE="0660", TAG+="uaccess"
  '';
  
  # X server configuration (needed for Steam and some applications)
  services.xserver = {
    enable = true;
    videoDrivers = [ "nvidia" ];
    # Don't enable display manager - we use greetd for Hyprland
  };
  
  # Enable XWayland for X11 apps like Steam
  programs.xwayland.enable = true;
  
  # Enable Steam with hardware support for controllers
  programs.steam.enable = true;
  hardware.steam-hardware.enable = true;

  # Your user
  users.users.bdsqqq = {
    isNormalUser = true;
    extraGroups = [ "wheel" "networkmanager" "audio" "video" "input" ];
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
        inputs.nix-flatpak.homeManagerModules.nix-flatpak
        ../../modules/home-manager/default.nix
        ../../modules/home-manager/profiles/hyprland.nix
        ../../modules/home-manager/flatpak.nix
      ];
    };
    
    extraSpecialArgs = { 
      inherit inputs; 
      isDarwin = false;
    };
  };

  environment.systemPackages = with pkgs; [
    # Network tools
    networkmanagerapplet
    
    # File manager
    nautilus
    
    # Additional desktop tools
    tree
    unzip
    usbutils  # For lsusb command
    
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
    
    # Controller support
    dualsensectl  # PS5 DualSense controller support
    hidapi  # HID API library for controller communication
    
    # Cursor theme (traditional macOS-style)
    apple-cursor  # Traditional macOS-style cursor theme
    
    # Scratchpad management
    pyprland  # Hyprland scratchpad manager for popup terminals
    
    # TUI Applications for scratchpads
    bluetuith    # Bluetooth TUI manager
    pulsemixer   # Audio/PipeWire TUI control
    lnav         # Advanced log file viewer
    bandwhich    # Network bandwidth monitor
    iotop        # Disk I/O monitor
    systemctl-tui # Systemd service manager
    dust         # Disk usage analyzer
    procs        # Modern process viewer
  ];

  # Fonts
  fonts.packages = with pkgs; [
    nerd-fonts.jetbrains-mono
    ibm-plex
    inter
    noto-fonts-emoji
  ];
  
  fonts = {
    enableDefaultPackages = false;  # Disable default DejaVu fonts
    fontconfig = {
      enable = true;
      defaultFonts = {
        serif = [ "IBM Plex Serif" ];
        sansSerif = [ "Inter" ];
        monospace = [ "Berkeley Mono" ];
        emoji = [ "Noto Color Emoji" ];
      };
      # Override fontconfig defaults with higher priority
      localConf = ''
        <?xml version="1.0"?>
        <!DOCTYPE fontconfig SYSTEM "fonts.dtd">
        <fontconfig>
          <!-- Override monospace preference with highest priority -->
          <alias binding="strong">
            <family>monospace</family>
            <prefer>
              <family>Berkeley Mono</family>
            </prefer>
          </alias>
          
          <!-- Override sans-serif preference with highest priority -->
          <alias binding="strong">
            <family>sans-serif</family>
            <prefer>
              <family>Inter</family>
            </prefer>
          </alias>
          
          <!-- Override serif preference with highest priority -->
          <alias binding="strong">
            <family>serif</family>
            <prefer>
              <family>IBM Plex Serif</family>
            </prefer>
          </alias>
          
          <!-- Block DejaVu and Liberation fonts explicitly -->
          <selectfont>
            <rejectfont>
              <pattern>
                <patelt name="family">
                  <string>DejaVu Sans Mono</string>
                </patelt>
              </pattern>
            </rejectfont>
            <rejectfont>
              <pattern>
                <patelt name="family">
                  <string>DejaVu Sans</string>
                </patelt>
              </pattern>
            </rejectfont>
            <rejectfont>
              <pattern>
                <patelt name="family">
                  <string>DejaVu Serif</string>
                </patelt>
              </pattern>
            </rejectfont>
            <rejectfont>
              <pattern>
                <patelt name="family">
                  <string>Liberation Sans</string>
                </patelt>
              </pattern>
            </rejectfont>
            <rejectfont>
              <pattern>
                <patelt name="family">
                  <string>Liberation Serif</string>
                </patelt>
              </pattern>
            </rejectfont>
          </selectfont>
        </fontconfig>
      '';
    };
  };

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
    # Fix PS5 controller bluetooth compatibility with Steam
    SDL_JOYSTICK_HIDAPI_PS5_RUMBLE = "0";
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

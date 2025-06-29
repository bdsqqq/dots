# NixOS configuration for Windows PC
# AMD Ryzen 5 5600G + NVIDIA RTX 3060 + 4K Display
{ pkgs, inputs, lib, config, ... }:

{
  imports = [
    # Hardware configuration
    ../../hardware/windows-pc.nix
    
    # NixOS-specific modules
    ../../modules/nixos/boot.nix
    ../../modules/nixos/graphics.nix
    
    # Shared cross-platform modules
    ../../modules/shared/default.nix
  ];

  # System identification
  networking = {
    hostName = "windows-pc";
    networkmanager.enable = true;
    
    # Firewall configuration
    firewall = {
      enable = true;
      allowedTCPPorts = [ 22 ]; # SSH
      allowedUDPPorts = [ ];
    };
  };

  # Time and locale
  time.timeZone = "America/New_York";  # Adjust as needed
  i18n = {
    defaultLocale = "en_US.UTF-8";
    extraLocaleSettings = {
      LC_ADDRESS = "en_US.UTF-8";
      LC_IDENTIFICATION = "en_US.UTF-8";
      LC_MEASUREMENT = "en_US.UTF-8";
      LC_MONETARY = "en_US.UTF-8";
      LC_NAME = "en_US.UTF-8";
      LC_NUMERIC = "en_US.UTF-8";
      LC_PAPER = "en_US.UTF-8";
      LC_TELEPHONE = "en_US.UTF-8";
      LC_TIME = "en_US.UTF-8";
    };
  };

  # Enable niri window manager
  programs.niri.enable = true;

  # Display manager configuration
  services.greetd = {
    enable = true;
    settings = {
      default_session = {
        command = "${pkgs.greetd.tuigreet}/bin/tuigreet --time --remember --cmd niri-session";
        user = "greeter";
      };
    };
  };

  # Audio configuration
  security.rtkit.enable = true;
  services.pipewire = {
    enable = true;
    alsa.enable = true;
    alsa.support32Bit = true;
    pulse.enable = true;
    jack.enable = true;
    
    # Low-latency configuration for gaming/audio work
    extraConfig.pipewire."92-low-latency" = {
      context.properties = {
        default.clock.rate = 48000;
        default.clock.quantum = 32;
        default.clock.min-quantum = 32;
        default.clock.max-quantum = 32;
      };
    };
  };

  # Input configuration
  services.libinput = {
    enable = true;
    mouse = {
      accelProfile = "flat";  # Disable mouse acceleration
      middleEmulation = false;
    };
  };

  # User configuration
  users.users.bdsqqq = {
    isNormalUser = true;
    home = "/home/bdsqqq";
    description = "Igor Bedesqui";
    extraGroups = [ 
      "wheel"           # sudo access
      "networkmanager"  # network management
      "docker"          # docker access
      "audio"           # audio devices
      "video"           # video devices
      "input"           # input devices
      "plugdev"         # removable devices
      "storage"         # storage devices
    ];
    shell = pkgs.zsh;
  };

  # Enable sudo for wheel group
  security.sudo.enable = true;

  # System-wide packages
  environment.systemPackages = with pkgs; [
    # Essential tools
    vim
    git
    curl
    wget
    htop
    neofetch
    
    # File management
    ranger
    fzf
    
    # Network tools
    networkmanager
    
    # Hardware monitoring
    lm_sensors
    smartmontools
    
    # Development tools (basic)
    gcc
    gnumake
    
    # Archive tools
    unzip
    zip
    p7zip
  ];

  # Enable services
  services = {
    # SSH daemon
    openssh = {
      enable = true;
      settings = {
        PasswordAuthentication = false;
        KbdInteractiveAuthentication = false;
        PermitRootLogin = "no";
      };
    };
    
    # Power management
    power-profiles-daemon.enable = true;
    
    # Hardware sensors
    # lm_sensors is enabled via hardware.sensor in NixOS
    
    # Bluetooth
    blueman.enable = true;
    
    # Printing (optional)
    printing.enable = true;
    
    # Auto-mounting
    udisks2.enable = true;
    
    # Location services (for time zone, etc.)
    geoclue2.enable = true;
  };

  # Security configuration
  security = {
    polkit.enable = true;
    # rtkit.enable is already set above for audio
    
    # Polkit rules for user actions
    polkit.extraConfig = ''
      polkit.addRule(function(action, subject) {
          if (action.id == "org.freedesktop.login1.suspend" ||
              action.id == "org.freedesktop.login1.suspend-multiple-sessions" ||
              action.id == "org.freedesktop.login1.hibernate" ||
              action.id == "org.freedesktop.login1.hibernate-multiple-sessions")
          {
              return polkit.Result.YES;
          }
      });
    '';
  };

  # XDG portal configuration for desktop integration
  xdg.portal = {
    enable = true;
    wlr.enable = true;
    extraPortals = with pkgs; [
      xdg-desktop-portal-gtk
      xdg-desktop-portal-wlr
    ];
  };

  # Fonts
  fonts = {
    packages = with pkgs; [
      noto-fonts
      noto-fonts-cjk
      noto-fonts-emoji
      liberation_ttf
      fira-code
      fira-code-symbols
      cascadia-code
      jetbrains-mono
      source-code-pro
    ];
    
    fontconfig = {
      enable = true;
      defaultFonts = {
        monospace = [ "Fira Code" "Cascadia Code" ];
        sansSerif = [ "Noto Sans" ];
        serif = [ "Noto Serif" ];
        emoji = [ "Noto Color Emoji" ];
      };
    };
  };

  # Programs
  programs = {
    zsh.enable = true;
    dconf.enable = true;
    
    # Gaming support
    steam = {
      enable = true;
      remotePlay.openFirewall = true;
      dedicatedServer.openFirewall = true;
    };
    
    # Gaming utilities
    gamemode.enable = true;
  };

  # Virtualization support
  virtualisation = {
    docker = {
      enable = true;
      enableNvidia = true;  # GPU support in containers
    };
    
    # KVM/QEMU support
    libvirtd.enable = true;
  };

  # Home Manager integration
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
      
      # Home Manager state version
      home.stateVersion = "25.05";
    };
    
    extraSpecialArgs = {
      inherit inputs;
      # Platform-specific context
      isNixOS = true;
      isDarwin = false;
      windowManager = "niri";
      isDesktop = true;
      hasNvidia = true;
    };
  };

  # Nix configuration
  nix = {
    settings = {
      experimental-features = [ "nix-command" "flakes" ];
      auto-optimise-store = true;
      
      # Parallel builds
      max-jobs = 12;  # Ryzen 5 5600G has 12 threads
      cores = 6;      # 6 physical cores
      
      # Binary caches
      substituters = [
        "https://cache.nixos.org/"
        "https://nix-community.cachix.org"
      ];
      trusted-public-keys = [
        "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY="
        "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
      ];
    };
    
    # Garbage collection
    gc = {
      automatic = true;
      dates = "weekly";
      options = "--delete-older-than 30d";
    };
  };

  # Allow unfree packages
  nixpkgs.config.allowUnfree = true;

  # System state version
  system.stateVersion = "25.05";
}

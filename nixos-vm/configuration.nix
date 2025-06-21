# NixOS VM Configuration with niri
{ config, pkgs, lib, inputs, unstable, ... }:

{
  imports = [
    ./hardware.nix
  ];

  # System basics
  system.stateVersion = "24.05";
  nixpkgs.config.allowUnfree = true;
  
  # Nix configuration
  nix = {
    settings = {
      experimental-features = [ "nix-command" "flakes" ];
      auto-optimise-store = true;
      trusted-users = [ "root" "@wheel" ];
    };
    gc = {
      automatic = true;
      dates = "weekly";
      options = "--delete-older-than 7d";
    };
  };

  # Networking
  networking = {
    hostName = "nixos-vm";
    networkmanager.enable = true;
    firewall = {
      enable = true;
      allowedTCPPorts = [ 22 ];
    };
  };

  # Timezone and internationalization
  time.timeZone = "America/New_York";
  i18n.defaultLocale = "en_US.UTF-8";
  
  console = {
    font = "Lat2-Terminus16";
    useXkbConfig = true;
  };

  # User account
  users.users.bdsqqq = {
    isNormalUser = true;
    description = "Igor Bedesqui";
    extraGroups = [ 
      "wheel" 
      "networkmanager" 
      "audio" 
      "video" 
      "docker" 
      "libvirtd"
      "input"
    ];
    shell = pkgs.zsh;
  };

  # Essential system programs
  programs = {
    zsh.enable = true;
    dconf.enable = true;
    light.enable = true;
  };

  # Security
  security = {
    polkit.enable = true;
    rtkit.enable = true;
    sudo.wheelNeedsPassword = false; # VM convenience
  };

  # Audio with PipeWire
  hardware.pulseaudio.enable = false;
  services.pipewire = {
    enable = true;
    alsa.enable = true;
    alsa.support32Bit = true;
    pulse.enable = true;
    jack.enable = true;
  };

  # Wayland and niri setup
  programs.niri = {
    enable = true;
    package = unstable.niri;
  };

  # Display manager with greetd
  services.greetd = {
    enable = true;
    settings = {
      default_session = {
        command = "${pkgs.greetd.tuigreet}/bin/tuigreet --time --cmd niri-session";
        user = "greeter";
      };
    };
  };

  # Essential Wayland services
  services = {
    dbus.enable = true;
    udev.enable = true;
    
    # Enable printing
    printing.enable = true;
    
    # SSH for remote access
    openssh = {
      enable = true;
      settings = {
        PasswordAuthentication = true;  # VM convenience
        PermitRootLogin = "no";
      };
    };
  };

  # XDG portal for screen sharing and file dialogs
  xdg.portal = {
    enable = true;
    wlr.enable = true;
    extraPortals = with pkgs; [
      xdg-desktop-portal-gtk
    ];
  };

  # Fonts
  fonts = {
    packages = with pkgs; [
      noto-fonts
      noto-fonts-cjk-sans
      noto-fonts-emoji
      liberation_ttf
      fira-code
      fira-code-symbols
      jetbrains-mono
      source-code-pro
      hack-font
    ];
    fontconfig = {
      enable = true;
      defaultFonts = {
        serif = [ "Noto Serif" ];
        sansSerif = [ "Noto Sans" ];
        monospace = [ "JetBrains Mono" ];
      };
    };
  };

  # System packages
  environment.systemPackages = with pkgs; [
    # Essential Wayland tools
    fuzzel          # App launcher
    mako            # Notification daemon
    waybar          # Status bar
    wl-clipboard    # Clipboard utilities
    grim            # Screenshot utility
    slurp           # Area selection for screenshots
    swaylock        # Screen locker
    swayidle        # Idle management
    kanshi          # Display configuration
    
    # System utilities
    networkmanager
    networkmanagerapplet
    pavucontrol     # Audio control
    brightnessctl   # Brightness control
    playerctl       # Media control
    
    # File management
    nautilus        # File manager
    file-roller     # Archive manager
    
    # Terminal and basic tools
    alacritty       # Terminal emulator
    kitty           # Alternative terminal
    firefox         # Web browser
    
    # Development basics (more in home-manager)
    git
    curl
    wget
    vim
    
    # System monitoring
    htop
    btop
    neofetch
  ];

  # Environment variables
  environment.sessionVariables = {
    NIXOS_OZONE_WL = "1";  # Enable Wayland for Electron apps
    MOZ_ENABLE_WAYLAND = "1";  # Enable Wayland for Firefox
    XDG_SESSION_TYPE = "wayland";
    XDG_CURRENT_DESKTOP = "niri";
  };

  # Services for development
  virtualisation = {
    docker = {
      enable = true;
      enableOnBoot = true;
    };
    libvirtd.enable = true;
  };

  # SOPS secrets management (optional, for API keys)
  # sops = {
  #   defaultSopsFile = ../secrets.yaml;
  #   age.keyFile = "/home/bdsqqq/.config/sops/age/keys.txt";
  #   secrets = {
  #     anthropic_api_key = {
  #       owner = "bdsqqq";
  #       group = "users";
  #       mode = "0400";
  #     };
  #     copilot_token = {
  #       owner = "bdsqqq";
  #       group = "users";
  #       mode = "0400";
  #     };
  #   };
  # };
}

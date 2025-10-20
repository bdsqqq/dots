{ pkgs, inputs, lib, config, modulesPath, ... }:

{
  imports = [
    ./hardware.nix
    ../../bundles/base.nix
    ../../bundles/desktop.nix
    ../../bundles/dev.nix
    ../../bundles/headless.nix
    ../../bundles/wm/hyprland.nix
    ../../system/nvidia.nix
    ../../system/sops.nix
  ];

  networking.hostName = "r56";
  networking.networkmanager.enable = true;
  networking.useDHCP = lib.mkDefault true;
  
  time.timeZone = "Europe/London";
  i18n.defaultLocale = "en_US.UTF-8";

  programs.hyprland.enable = true;
  # tailscale provided by base bundle
  
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
      configFile = ../../assets/kanata.kbd;
    };
  };
  
  # syncthing, flatpak, bluetooth, audio, login provided by bundles
  
  # Auto-trust paired devices for better persistence (host-specific MAC address)
  systemd.services.bluetooth-auto-trust = {
    description = "Auto-trust Bluetooth devices";
    after = [ "bluetooth.service" ];
    wantedBy = [ "multi-user.target" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      ExecStart = "${pkgs.bash}/bin/bash -c '${pkgs.bluez}/bin/bluetoothctl trust E6:D2:2B:50:5B:64 || true'";
    };
  };
  
  # SSH provided by base bundle
  
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

  # home-manager module is enabled at flake level; user-layer is provided via bundles
  home-manager = {
    useGlobalPkgs = true;
    useUserPackages = true;
    extraSpecialArgs = { inherit inputs; isDarwin = false; hostSystem = "x86_64-linux"; };
    users.bdsqqq = {
      home.username = "bdsqqq";
      home.homeDirectory = "/home/bdsqqq";
      home.stateVersion = "25.05";
      programs.home-manager.enable = true;
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
    linuxConsoleTools  # JS utilities for testing controllers
    
    # Cursor theme (traditional macOS-style)
    apple-cursor  # Traditional macOS-style cursor theme
  ];

  # Fonts - extended packages + fontconfig for DejaVu blocking (host-specific)
  fonts.packages = with pkgs; [
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

  # Set dark theme system-wide (NVIDIA vars provided by system/nvidia.nix)
  environment.sessionVariables = {
    # Force dark theme for GTK applications
    GTK_THEME = "Adwaita:dark";
    # Set color scheme preference
    COLOR_SCHEME = "prefer-dark";
    # Wayland session type
    XDG_SESSION_TYPE = "wayland";
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

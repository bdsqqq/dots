{ pkgs, inputs, lib, config, modulesPath, ... }:

let
  berkeleyMono = pkgs.stdenv.mkDerivation {
    pname = "berkeley-mono";
    version = "1.0.0";
    src = inputs.berkeley-mono;
    dontConfigure = true;
    dontBuild = true;
    installPhase = ''
      runHook preInstall
      mkdir -p $out/share/fonts/opentype/berkeley-mono
      for file in "$src"/*.otf; do
        install -m644 "$file" $out/share/fonts/opentype/berkeley-mono/
      done
      runHook postInstall
    '';
  };
in
{
  _module.args.torchBackend = "cu121";

  stylix = {
    enable = true;
    image = ../../assets/wallpaper_without_mask.jpg;
    base16Scheme = ../../modules/shared/e-ink-scheme.yaml;
    polarity = "dark";
    
    fonts = {
      monospace = {
        package = berkeleyMono;
        name = "Berkeley Mono";
      };
      sansSerif = {
        package = pkgs.inter;
        name = "Inter";
      };
      serif = {
        package = pkgs.dejavu_fonts;
        name = "DejaVu Serif";
      };
      sizes = {
        terminal = 14;
        applications = 12;
        desktop = 12;
      };
    };
    
    cursor = {
      package = pkgs.apple-cursor;
      name = "macOS";
      size = 24;
    };
    
    opacity = {
      terminal = 0.7;
    };
    
  };

  imports = [
    ./hardware.nix
    ../../bundles/base.nix
    ../../bundles/headless.nix
    ../../bundles/dev.nix
    ../../bundles/desktop.nix
    ../../bundles/wm/niri.nix
    ../../system/nvidia.nix
    ../../system/bluetooth.nix
    ../../system/audio.nix
    ../../system/vector.nix
    ../../user/ghostty.nix
    ../../user/quickshell.nix
    ../../user/gaming.nix
    ../../system/flatpak.nix
  ];

  networking.hostName = "r56";
  networking.networkmanager.enable = true;
  networking.useDHCP = lib.mkDefault true;
  
  # allow minecraft server on tailscale
  networking.firewall.interfaces."tailscale0".allowedTCPPorts = [ 25565 ];
  networking.firewall.interfaces."tailscale0".allowedUDPPorts = [ 25565 ];
  
  time.timeZone = "Europe/London";
  i18n.defaultLocale = "en_US.UTF-8";

  # ensure DISPLAY is set for xwayland-satellite (spawned as :0 by niri/hyprland)
  environment.sessionVariables.DISPLAY = ":0";

  # tailscale and ssh provided by base bundle; auth key for headless auth
  services.tailscale = {
    authKeyFile = lib.mkIf (config.sops.secrets ? tailscale_auth_key) config.sops.secrets.tailscale_auth_key.path;
  };
  
  # syncthing provided by headless bundle; declarative mesh settings here
  services.syncthing = {
    settings = {
      gui = {
        user = "bdsqqq";
        password = "$2a$10$jGT.D5kEaNOxsNaCvrmfqukdEW5e9ugrXU/dR15oSAACbDEYIR5YO";
      };
      options = {
        urAccepted = -1;
        globalAnnounceEnabled = false;
        localAnnounceEnabled = false;
        relaysEnabled = false;
        natEnabled = false;
      };

      devices = {
        "mbp-m2" = {
          id = "6QPGO5Z-ZBZZVDW-MCYFBKB-MGZQO47-GITV6C5-5YGBXLT-VWHNAQ4-5XMKDAG";
          addresses = [ "tcp://mbp-m2:22000" "quic://mbp-m2:22000" ];
          introducer = true;
        };
        "htz-relay" = {
          id = "HPMO7GH-P5UX4LC-OYSWWVP-XTMOUWL-QXUDAYH-ZJXXQDJ-QN677MY-QNQACQH";
          addresses = [ "tcp://htz-relay:22000" "quic://htz-relay:22000" ];
        };
        "lgo-z2e" = {
          id = "4B7Q2Z5-SNAOQJO-S4L4FSG-IBBV5XH-67DUXTW-L3Z3JT7-CUQCWP6-TKHP5AG";
          addresses = [ "tcp://lgo-z2e:22000" "quic://lgo-z2e:22000" ];
        };
      };

      folders = {
        commonplace = {
          enable = true;
          id = "sqz7z-a6tfg";
          label = "commonplace";
          path = "/home/bdsqqq/commonplace";
          type = "sendreceive";
          rescanIntervalS = 60;
          devices = [ "mbp-m2" "htz-relay" "lgo-z2e" ];
          versioning = {
            type = "trashcan";
            params.cleanoutDays = "0";
          };
        };

        prism-instances = {
          enable = true;
          id = "prism-instances";
          label = "PrismLauncher instances";
          path = "/home/bdsqqq/.local/share/PrismLauncher/instances";
          type = "sendreceive";
          rescanIntervalS = 120;
          devices = [ "mbp-m2" "lgo-z2e" ];
        };

        zen-browser = {
          enable = true;
          id = "zen-browser";
          label = "Zen Browser";
          path = "/home/bdsqqq/.var/app/app.zen_browser.zen/.zen";
          type = "sendreceive";
          rescanIntervalS = 60;
          devices = [ "mbp-m2" "lgo-z2e" ];
          versioning = {
            type = "trashcan";
            params.cleanoutDays = "30";
          };
        };
      };
    };
  };

  # Your user
  users.users.bdsqqq = {
    isNormalUser = true;
    extraGroups = [ "wheel" "networkmanager" "audio" "video" "input" ];
    shell = pkgs.zsh;
  };

  # Enable zsh
  programs.zsh.enable = true;

  # Steam with controller support and proper wayland scaling
  programs.steam = {
    enable = true;
    remotePlay.openFirewall = true;
    dedicatedServer.openFirewall = true;
    package = pkgs.steam.override {
      extraEnv = {
        STEAM_FORCE_DESKTOPUI_SCALING = "1.5";
      };
    };
  };
  
  # udev rules for PS5 DualSense and other controllers
  hardware.steam-hardware.enable = true;

  # home-manager module is enabled at flake level; user-layer is provided via bundles
  home-manager = {
    useGlobalPkgs = true;
    useUserPackages = true;
    backupFileExtension = "backup";
    extraSpecialArgs = { inherit inputs; isDarwin = false; hostSystem = "x86_64-linux"; headMode = "graphical"; torchBackend = "cu121"; };
    sharedModules = [
      inputs.vicinae.homeManagerModules.default
    ];
    users.bdsqqq = {
      home.username = "bdsqqq";
      home.homeDirectory = "/home/bdsqqq";
      home.stateVersion = "25.05";
      programs.home-manager.enable = true;
      
      # disable stylix targets we manage manually
      stylix.targets.ghostty.enable = false;
      
      # fontconfig for crisp font rendering at 1.5x
      fonts.fontconfig = {
        enable = true;
        defaultFonts = {
          monospace = [ "Berkeley Mono" ];
          sansSerif = [ "Inter" ];
          serif = [ "DejaVu Serif" ];
        };
      };
      
      gtk = {
        enable = true;
        gtk3.extraConfig = {
          gtk-xft-antialias = 1;
          gtk-xft-hinting = 1;
          gtk-xft-hintstyle = "hintslight";
          gtk-xft-rgba = "rgb";
        };
        gtk4.extraConfig = {
          gtk-xft-antialias = 1;
          gtk-xft-hinting = 1;
          gtk-xft-hintstyle = "hintslight";
        };
      };
      
      services.vicinae = {
        enable = true;
        systemd.enable = true;
        systemd.autoStart = true;
        settings = {
          theme.name = lib.mkForce "vicinae-dark";
          window = {
            csd = true;
            opacity = lib.mkForce 0.95;
            rounding = 0;
          };
          # on_demand allows compositor to route clicks outside vicinae,
          # enabling focus-loss detection for click-outside-to-close
          launcher_window.layer_shell.keyboard_interactivity = "on_demand";
        };
      };
    };
  };
  
  # binary caches (niri cache auto-enabled by niri-flake module)
  nix.settings = {
    extra-substituters = [ 
      "https://vicinae.cachix.org"
    ];
    extra-trusted-public-keys = [ 
      "vicinae.cachix.org-1:1kDrfienkGHPYbkpNj1mWTr7Fm1+zcenzgTizIcI3oc="
    ];
  };

  environment.systemPackages = with pkgs; [
    # Basic system tools
    tree
    unzip
    usbutils
    libnotify
  ];

  # fonts provided by base bundle

  nixpkgs.config.allowUnfree = true;
  nixpkgs.hostPlatform = lib.mkDefault "x86_64-linux";
  
  # Automatic garbage collection
  nix.gc = {
    automatic = true;
    dates = "weekly";
    options = "--delete-older-than 30d";
  };

  # System state version
  system.stateVersion = "25.05";

  # set syncthing GUI password hash from sops secret (writes directly to config.xml)
  systemd.services.syncthing-gui-password = {
    description = "Set Syncthing GUI password hash from sops secret";
    after = [ "syncthing-init.service" "sops-install-secrets.service" ];
    before = [ "syncthing.service" ];
    wantedBy = [ "multi-user.target" ];
    serviceConfig = {
      Type = "oneshot";
      User = "bdsqqq";
      RemainAfterExit = true;
    };
    path = [ pkgs.gnused pkgs.coreutils ];
    script = ''
      set -euo pipefail
      
      SECRET_FILE="/run/secrets/syncthing_gui_password_hash"
      if [ ! -f "$SECRET_FILE" ]; then
        echo "syncthing-gui-password: secret not found, skipping"
        exit 0
      fi
      
      HASH="$(cat "$SECRET_FILE")"
      CFG_FILE="/home/bdsqqq/.config/syncthing/config.xml"
      
      if [ ! -f "$CFG_FILE" ]; then
        echo "syncthing-gui-password: config.xml not found, skipping"
        exit 0
      fi
      
      # update password hash in config.xml
      sed -i "s|<password>.*</password>|<password>$HASH</password>|" "$CFG_FILE"
      
      echo "syncthing-gui-password: hash updated in config.xml"
    '';
  };
}

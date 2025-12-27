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
        terminal = 16;
        applications = 14;
        desktop = 14;
      };
    };
    
    cursor = {
      package = pkgs.apple-cursor;
      name = "macOS";
      size = 32;
    };
    
    opacity = {
      terminal = 0.85;
    };
  };

  imports = [
    ./hardware.nix
    ../../bundles/base.nix
    ../../bundles/headless.nix
    ../../bundles/dev.nix
    ../../bundles/desktop.nix
    ../../bundles/wm/niri.nix
    ../../system/bluetooth.nix
    ../../system/audio.nix
    ../../system/vector.nix
    ../../user/ghostty.nix
    ../../user/gaming.nix
    ../../user/quickshell.nix
    ../../system/flatpak.nix
  ];

  networking.hostName = "lgo-z2e";
  networking.networkmanager.enable = true;
  networking.useDHCP = lib.mkDefault true;
  
  time.timeZone = "Europe/London";
  i18n.defaultLocale = "en_US.UTF-8";

  environment.sessionVariables.DISPLAY = ":0";

  # jovian-nixos: steam/gaming support (niri is primary session)
  jovian = {
    steam = {
      enable = true;
      autoStart = false;
      user = "bdsqqq";
    };
    decky-loader.enable = true;
    hardware.has.amd.gpu = true;
  };

  # handheld daemon for controller/gyro/TDP management
  services.handheld-daemon = {
    enable = true;
    user = "bdsqqq";
    ui.enable = true;
  };

  # tailscale auth
  services.tailscale = {
    authKeyFile = lib.mkIf (config.sops.secrets ? tailscale_auth_key) config.sops.secrets.tailscale_auth_key.path;
  };
  
  # syncthing mesh
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
          addresses = [ "tcp://100.87.59.2:22000" "quic://100.87.59.2:22000" ];
          introducer = true;
        };
        "htz-relay" = {
          id = "HPMO7GH-P5UX4LC-OYSWWVP-XTMOUWL-QXUDAYH-ZJXXQDJ-QN677MY-QNQACQH";
          addresses = [ "tcp://100.101.195.56:22000" "quic://100.101.195.56:22000" ];
        };
        "r56" = {
          id = "XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX";
          addresses = [ "tcp://100.x.x.x:22000" "quic://100.x.x.x:22000" ];
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
          devices = [ "mbp-m2" "htz-relay" "r56" ];
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
          devices = [ "mbp-m2" "r56" ];
        };
      };
    };
  };

  users.users.bdsqqq = {
    isNormalUser = true;
    extraGroups = [ "wheel" "networkmanager" "audio" "video" "input" ];
    shell = pkgs.zsh;
  };

  programs.zsh.enable = true;

  # steam with handheld-appropriate scaling
  programs.steam = {
    enable = true;
    remotePlay.openFirewall = true;
    dedicatedServer.openFirewall = true;
  };
  
  hardware.steam-hardware.enable = true;

  home-manager = {
    useGlobalPkgs = true;
    useUserPackages = true;
    backupFileExtension = "backup";
    extraSpecialArgs = { inherit inputs; isDarwin = false; hostSystem = "x86_64-linux"; headMode = "graphical"; };
    sharedModules = [
      inputs.vicinae.homeManagerModules.default
    ];
    users.bdsqqq = {
      home.username = "bdsqqq";
      home.homeDirectory = "/home/bdsqqq";
      home.stateVersion = "25.05";
      programs.home-manager.enable = true;
      
      stylix.targets.ghostty.enable = false;
      
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
      
      # TODO: re-enable after initial install - may have cuda deps
      # services.vicinae = {
      #   enable = true;
      #   autoStart = true;
      #   settings = {
      #     theme.name = lib.mkForce "vicinae-dark";
      #     window = {
      #       csd = true;
      #       opacity = lib.mkForce 0.95;
      #       rounding = 0;
      #     };
      #   };
      # };
    };
  };
  
  nix.settings = {
    extra-substituters = [ 
      "https://vicinae.cachix.org"
    ];
    extra-trusted-public-keys = [ 
      "vicinae.cachix.org-1:1kDrfienkGHPYbkpNj1mWTr7Fm1+zcenzgTizIcI3oc="
    ];
  };

  environment.systemPackages = with pkgs; [
    tree
    unzip
    usbutils
    libnotify
    
    # handheld-specific
    mangohud
    gamemode
  ];

  nixpkgs.config.allowUnfree = true;
  nixpkgs.hostPlatform = lib.mkDefault "x86_64-linux";
  
  nix.gc = {
    automatic = true;
    dates = "weekly";
    options = "--delete-older-than 30d";
  };

  system.stateVersion = "25.05";

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
      
      sed -i "s|<password>.*</password>|<password>$HASH</password>|" "$CFG_FILE"
      
      echo "syncthing-gui-password: hash updated in config.xml"
    '';
  };
}

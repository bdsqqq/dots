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
    image = ../../assets/wallpaper.jpg;
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
    ../../bundles/wm/hyprland.nix
    ../../system/nvidia.nix
    ../../system/bluetooth.nix
    ../../system/fan-control.nix
    ../../system/audio.nix
    ../../system/vector.nix
    ../../user/ghostty.nix
    ../../user/waybar.nix
    ../../user/gaming.nix
  ];

  networking.hostName = "r56";
  networking.networkmanager.enable = true;
  networking.useDHCP = lib.mkDefault true;
  
  time.timeZone = "Europe/London";
  i18n.defaultLocale = "en_US.UTF-8";

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
          addresses = [ "tcp://100.87.59.2:22000" "quic://100.87.59.2:22000" ];
          introducer = true;
        };
        "htz-relay" = {
          id = "HPMO7GH-P5UX4LC-OYSWWVP-XTMOUWL-QXUDAYH-ZJXXQDJ-QN677MY-QNQACQH";
          addresses = [ "tcp://100.101.195.56:22000" "quic://100.101.195.56:22000" ];
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
          devices = [ "mbp-m2" "htz-relay" ];
          versioning = {
            type = "trashcan";
            params.cleanoutDays = "0";
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

  # Steam
  programs.steam.enable = true;

  # Flatpak apps
  services.flatpak = {
    enable = true;
    uninstallUnmanaged = true;
    remotes = [{
      name = "flathub";
      location = "https://dl.flathub.org/repo/flathub.flatpakrepo";
    }];
    packages = [
      "app.zen_browser.zen"
    ];
  };

  # home-manager module is enabled at flake level; user-layer is provided via bundles
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
      
      # disable stylix targets we manage manually
      stylix.targets.hyprland.enable = false;
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
      
      # dconf for gsettings persistence (portal-gtk reads this for theme preference)
      dconf.enable = true;
      
      services.vicinae = {
        enable = true;
        autoStart = true;
        settings = {
          theme.name = "vicinae-dark";
          window = {
            csd = true;
            opacity = 0.95;
            rounding = 0;
          };
        };
      };
    };
  };
  
  # vicinae cachix binary cache
  nix.settings = {
    extra-substituters = [ "https://vicinae.cachix.org" ];
    extra-trusted-public-keys = [ "vicinae.cachix.org-1:1kDrfienkGHPYbkpNj1mWTr7Fm1+zcenzgTizIcI3oc=" ];
  };

  environment.systemPackages = with pkgs; [
    # Basic system tools
    tree
    unzip
    usbutils
    
    # AI tools - whisper-cpp with CUDA for GPU acceleration
    (whisper-cpp.override { 
      cudaSupport = true; 
      cudaPackages = pkgs.cudaPackages;
    })
  ];

  # fonts provided by base bundle

  nixpkgs.config.allowUnfree = true;
  nixpkgs.config.cudaSupport = true;
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

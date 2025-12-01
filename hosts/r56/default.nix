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
    ../../user/ghostty.nix
    ../../user/waybar.nix
    ../../user/gaming.nix
  ];

  networking.hostName = "r56";
  networking.networkmanager.enable = true;
  networking.useDHCP = lib.mkDefault true;
  
  time.timeZone = "Europe/London";
  i18n.defaultLocale = "en_US.UTF-8";

  # tailscale and ssh provided by base bundle
  # syncthing provided by headless bundle

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
      
      # disable stylix hyprland target - we manage it manually
      stylix.targets.hyprland.enable = false;
      
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
}

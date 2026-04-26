# hosts/mbp14.local/default.nix
# Enhanced host configuration with improved input handling
{ lib, pkgs, inputs, systems ? [ ], pkgsFor ? null, ... }:
let syncthing = import ../../modules/syncthing.nix { inherit lib; };
in {
  imports = [
    inputs.home-manager.darwinModules.home-manager
    ../../bundles/base.nix
    ../../bundles/desktop.nix
    ../../bundles/dev.nix
    ../../bundles/headless.nix
    ../../system/sops.nix
    ../../system/homebrew.nix
    ../../system/macos-defaults.nix
    ../../system/kanata.nix
    ../../system/vector.nix
    ../../user/gaming.nix
  ];

  # home-manager module enabled at flake level; user-layer provided via bundles
  home-manager = {
    useGlobalPkgs = true;
    useUserPackages = true;
    extraSpecialArgs = {
      inherit inputs systems pkgsFor;
      isDarwin = true;
      hostSystem = "aarch64-darwin";
      headMode = "graphical";
    };
    users.bdsqqq = { lib, pkgs, config, ... }: {
      home.username = "bdsqqq";
      home.homeDirectory = "/Users/bdsqqq";
      home.stateVersion = "25.05";
      programs.home-manager.enable = true;

      # declarative syncthing settings (daemon managed by launchd in system/syncthing.nix)
      services.syncthing = {
        enable = true;
        overrideFolders = true;
        overrideDevices = true;
        # use guiAddress (not settings.gui.address) - home-manager's init script
        # PATCHes guiAddress after PUTting settings.gui, so settings.gui.address gets overwritten
        guiAddress = "0.0.0.0:8384";

        settings = {
          gui = {
            user = "bdsqqq";
            password =
              "$2a$10$jGT.D5kEaNOxsNaCvrmfqukdEW5e9ugrXU/dR15oSAACbDEYIR5YO";
          };
          options = {
            urAccepted = -1;
            globalAnnounceEnabled = false;
            localAnnounceEnabled = false;
            relaysEnabled = false;
            natEnabled = false;
          };

          devices =
            syncthing.devicesFor [ "htz-relay" "r56" "lgo-z2e" "iph16" "ipd" ];

          folders = {
            commonplace =
              syncthing.folderFor "commonplace" config.home.homeDirectory true [
                "htz-relay"
                "r56"
                "lgo-z2e"
                "iph16"
                "ipd"
              ] { label = "commonplace"; };
            prism-instances =
              syncthing.folderFor "prism-instances" config.home.homeDirectory
              true [ "r56" "lgo-z2e" ] {
                label = "PrismLauncher instances";
                rescanIntervalS = 120;
                versioning = null;
              };
            pi-sessions =
              syncthing.folderFor "pi-sessions" config.home.homeDirectory true
              [ "lgo-z2e" ] { };
            helium-remotes =
              syncthing.folderFor "helium-remotes" config.home.homeDirectory true [
                "htz-relay"
                "r56"
                "lgo-z2e"
              ] { };
          };
        };
      };

      # fix: home-manager syncthing doesn't set RunAtLoad, so manually override
      launchd.agents.syncthing.config.RunAtLoad = true;
      launchd.agents.syncthing-init.config.RunAtLoad = true;
    };
  };

  # Host-specific settings
  # System identification for multi-host setups
  networking = {
    hostName = "mbp-m2.local"; # FQDN is fine for HostName
    localHostName = "mbp-m2"; # must NOT contain dots (mDNS)
    computerName = "mbp-m2"; # UI name
  };

  # ensure darwin user exists with a concrete home path so HM can derive paths
  users.users.bdsqqq.home = "/Users/bdsqqq";
  system.primaryUser = "bdsqqq";
  my.primaryUser = "bdsqqq";
  my.heliumRemotes = {
    enable = true;
    tabsExtension.enable = true;
  };

  # required by nix-darwin
  system.stateVersion = 6;

  # darwin baselines
  nixpkgs = {
    hostPlatform = "aarch64-darwin";
    config.allowUnfree = true;
  };

  # Kanata enabled when host imports system/kanata.nix
}

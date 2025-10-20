# hosts/mbp14.local/default.nix
# Enhanced host configuration with improved input handling
{ pkgs, inputs, systems ? [ ], pkgsFor ? null, ... }: {
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
    ../../system/syncthing-automerge.nix
  ];

  # home-manager module enabled at flake level; user-layer provided via bundles
  home-manager = {
    useGlobalPkgs = true;
    useUserPackages = true;
    extraSpecialArgs = {
      inherit inputs systems pkgsFor;
      isDarwin = true;
      hostSystem = "aarch64-darwin";
    };
    users.bdsqqq = {
      home.username = "bdsqqq";
      home.homeDirectory = "/Users/bdsqqq";
      home.stateVersion = "25.05";
      programs.home-manager.enable = true;
    };
  };

  

  # Host-specific settings
  # System identification for multi-host setups
  networking = {
    hostName = "mbp14.local";      # FQDN is fine for HostName
    localHostName = "mbp14";       # must NOT contain dots (mDNS)
    computerName = "mbp14";        # UI name
  };

  # ensure darwin user exists with a concrete home path so HM can derive paths
  users.users.bdsqqq.home = "/Users/bdsqqq";
  system.primaryUser = "bdsqqq";

  # required by nix-darwin; replace value previously defined in modules/darwin/default.nix
  system.stateVersion = 6;

  # minimal darwin baselines that used to live in modules/darwin/default.nix
  nix.settings.experimental-features = "nix-command flakes";
  nixpkgs = {
    hostPlatform = "aarch64-darwin";
    config.allowUnfree = true;
  };

  # let nix-darwin own and link GUI apps into this directory
  environment.darwinConfig.applicationsDir = "/Applications/Nix Apps";

  # Enable Karabiner Elements configuration management
  # custom.karabiner.enable = true;
  
  # Enable Kanata (host-specific module kept)
  custom.kanata.enable = true;

  # Host-only syncthing automerge
  custom.syncthing-automerge.enable = true;
  
  # Example of using enhanced specialArgs for conditional configuration
  # This demonstrates how modules can access system information
  # assertions = [
  #   {
  #     assertion = pkgs.stdenv.system == "aarch64-darwin";
  #     message = "This configuration is designed for Apple Silicon Macs";
  #   }
  # ];
}

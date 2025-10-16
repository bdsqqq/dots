# hosts/mbp14.local/default.nix
# Enhanced host configuration with improved input handling
{ pkgs, inputs, systems ? [ ], pkgsFor ? null, ... }: {
  imports = [
    inputs.home-manager.darwinModules.home-manager
    ../../bundles/base.nix
    ../../bundles/headless.nix
    ../../modules/darwin/syncthing-automerge.nix
  ];

  # Configure Home Manager with enhanced input passing
  home-manager = {
    useGlobalPkgs = true;
    useUserPackages = true;
    backupFileExtension = "backup";  # Backup existing files instead of failing
    users.bdsqqq = {
      imports = [
        inputs.nixvim.homeManagerModules.nixvim
        inputs.sops-nix.homeManagerModules.sops
        ../../modules/home-manager/default.nix
      ];
    };
    # Pass all enhanced specialArgs to home-manager modules
    extraSpecialArgs = {
      inherit inputs systems pkgsFor;
      isDarwin = true;
    };
  };

  # Host-specific settings
  # System identification for multi-host setups
  networking.hostName = "mbp14.local";

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

# hosts/mbp14.local/default.nix
# Enhanced host configuration with improved input handling
{ pkgs, inputs, systems ? [ ], pkgsFor ? null, ... }: {
  imports = [
    # Import all the modular components
    ../../modules/darwin/default.nix
    inputs.home-manager.darwinModules.home-manager
  ];

  # Configure Home Manager with enhanced input passing
  home-manager = {
    useGlobalPkgs = true;
    useUserPackages = true;
    backupFileExtension = "backup";  # Backup existing files instead of failing
    users.bdsqqq = {
      imports = [
        # inputs.nixvim.homeManagerModules.nixvim  # Disabled due to wayland build issues on macOS
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
  
  # Enable Kanata for unified keyboard configuration
  custom.kanata.enable = true;
  
  # Enable Syncthing automerge service
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

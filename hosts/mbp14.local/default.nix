# hosts/mbp14.local/default.nix
{ pkgs, inputs, ... }: {
  imports = [
    # Import all the modular components
    ../../modules/darwin/default.nix
    inputs.home-manager.darwinModules.home-manager
  ];

  # Configure Home Manager
  home-manager = {
    useGlobalPkgs = true;
    useUserPackages = true;
    users.bdsqqq = {
      imports = [
        inputs.nixvim.homeManagerModules.nixvim
        inputs.sops-nix.homeManagerModules.sops
        ../../modules/home-manager/default.nix
      ];
    };
    extraSpecialArgs = { inherit inputs; };
  };

  # Host-specific settings, like networking.hostName, can go here
  # Example:
  # networking.hostName = "mbp14.local";
}

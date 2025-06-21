{ config, pkgs, inputs, ... }:

{
  # List packages installed in system profile. To search by name, run:
  # $ nix-env -qaP | grep wget
  environment.systemPackages = [
    pkgs.vim
    # Test unstable overlay - uncomment to test unstable packages
    # pkgs.unstable.neovim  # Example: Use unstable neovim
  ];

  users.users.bdsqqq = {
    home = "/Users/bdsqqq";
  };

  environment.darwinConfig = "$HOME/.config/nix-darwin/configuration.nix";

  # Necessary for using flakes on this system.
  nix.settings.experimental-features = "nix-command flakes";

  # Enable alternative shell support in nix-darwin.
  # programs.fish.enable = true;

  # Set Git commit hash for darwin-version.
  # system.configurationRevision = self.rev or self.dirtyRev or null;

  # Used for backwards compatibility, please read the changelog before changing.
  # $ darwin-rebuild changelog
  system.stateVersion = 6;

  # The platform the configuration will be used on.
  nixpkgs.hostPlatform = "aarch64-darwin";

  # Allow unfree packages
  nixpkgs.config.allowUnfree = true;

  # Configure overlays for unstable packages access
  # Provides pkgs.unstable.packageName for bleeding edge packages
  # Default pkgs.packageName remains stable
  nixpkgs.overlays = [
    # Unstable packages overlay - provides pkgs.unstable.packageName
    (final: prev: {
      unstable = import inputs.nixpkgs-unstable {
        inherit (final) system;
        config.allowUnfree = true;
      };
    })
  ];
}

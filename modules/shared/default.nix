# Shared configuration between Darwin and NixOS
{ config, pkgs, lib, ... }:

{
  imports = [
    ./stylix.nix
  ];
  # Common Nix settings
  nix = {
    settings = {
      # Binary caches
      substituters = [
        "https://cache.nixos.org/"
        "https://nix-community.cachix.org"
      ];
      trusted-public-keys = [
        "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY="
        "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
      ];
    };
    optimise.automatic = true;
  };

  # Common environment variables
  environment.variables = {
    EDITOR = "vim";
    VISUAL = "vim";
  };

  # Common packages
  environment.systemPackages = with pkgs; [
    vim
    git
    curl
    wget
    htop
  ];
}
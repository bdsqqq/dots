# Shared configuration between Darwin and NixOS
{ config, pkgs, lib, ... }:

{
  # Common Nix settings
  nix = {
    settings = {
      experimental-features = [ "nix-command" "flakes" ];
      auto-optimise-store = true;
      
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
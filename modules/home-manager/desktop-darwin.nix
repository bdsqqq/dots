# macOS-specific desktop features
{ config, pkgs, lib, ... }:

{
  # macOS-specific applications
  home.packages = with pkgs; [
    # macOS apps that don't have Linux equivalents
    # (most GUI apps are handled in applications.nix)
  ];

  # macOS-specific configurations
  # (most desktop configs are platform-agnostic)
}
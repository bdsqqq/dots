# Shared Stylix configuration for both Darwin and NixOS
{ config, lib, ... }:

# Only enable stylix if it's available (i.e., if the stylix nixos module is imported)
lib.mkIf (config ? stylix) {
  stylix = {
    enable = true;

    # Enable automatic detection and theming of supported applications
    autoEnable = true;

    # Keep e-ink color scheme but use loupe wallpaper
    base16Scheme = ./e-ink-scheme.yaml;
    image = ../../../modules/shared/loupe-mono-dark.jpg;

    # Opacity settings - translucent
    opacity = {
      applications = 0.65;
      terminal = 0.65;
      desktop = 0.65;
      popups = 0.65;
    };

    # Set polarity based on selected theme
    polarity = "dark";
  };
}

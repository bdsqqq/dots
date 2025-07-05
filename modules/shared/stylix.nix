# Shared Stylix configuration for both Darwin and NixOS
{ config, pkgs, lib, ... }:

{
  stylix = {
    enable = true;
    
    # Base16 color scheme - you can change this to any base16 scheme
    base16Scheme = "${pkgs.base16-schemes}/share/themes/gruvbox-dark-medium.yaml";
    
    # You can also use a custom image to generate colors
    # image = ./path/to/your/wallpaper.jpg;
    
    # Opacity settings
    opacity = {
      applications = 1.0;
      terminal = 0.9;
      desktop = 1.0;
      popups = 1.0;
    };
    
    # Polarity (dark/light theme)
    polarity = "dark";
  };
}

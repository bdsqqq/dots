# Shared Stylix configuration for both Darwin and NixOS
{ config, pkgs, lib, inputs, ... }:

let
  polarity = "dark";
  
  wallpaperImage = if polarity == "dark" 
    then inputs.loupe-dark
    else inputs.loupe-light;
    
  colorScheme = if polarity == "dark"
    then ./e-ink-scheme.yaml
    else ./e-ink-light-scheme.yaml;
in
{
  stylix = {
    enable = true; 
    # Enable automatic detection and theming of supported applications
    autoEnable = true;
    
    # Keep e-ink color scheme but use loupe wallpaper
    base16Scheme = colorScheme;
    image = wallpaperImage;
    
    opacity = {
      applications = 0.65;
      terminal = 0.65;
      desktop = 0.65;
      popups = 0.65;
    };
    
    polarity = polarity;
  };
}

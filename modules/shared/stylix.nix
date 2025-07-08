# Shared Stylix configuration for both Darwin and NixOS
{ config, pkgs, lib, ... }:

{
  stylix = {
    enable = true;
    
    # Enable automatic detection and theming of supported applications
    autoEnable = true;  # This is the default, but making it explicit
    
    # E-ink color scheme - minimal grayscale theme
    base16Scheme = ./e-ink-scheme.yaml;  # Change to ./e-ink-light-scheme.yaml for light theme
    
    # You can also use a custom image to generate colors
    # image = ./path/to/your/wallpaper.jpg;
    
    # Opacity settings - translucent
    opacity = {
      applications = 0.65;
      terminal = 0.65;
      desktop = 0.65;
      popups = 0.65;
    };
    
    # Polarity (dark/light theme)
    polarity = "dark";  # Change to "light" if using e-ink-light-scheme.yaml
  };
}

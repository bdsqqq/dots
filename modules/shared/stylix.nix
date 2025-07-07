# Shared Stylix configuration for both Darwin and NixOS
{ config, pkgs, lib, ... }:

{
  stylix = {
    enable = true;
    
    # E-ink color scheme - minimal grayscale theme
    base16Scheme = ./e-ink-scheme.yaml;  # Change to ./e-ink-light-scheme.yaml for light theme
    
    # You can also use a custom image to generate colors
    # image = ./path/to/your/wallpaper.jpg;
    
    # Opacity settings - reduced for e-ink aesthetic
    opacity = {
      applications = 1.0;
      terminal = 1.0;  # Solid background for e-ink look
      desktop = 1.0;
      popups = 1.0;
    };
    
    # Polarity (dark/light theme)
    polarity = "dark";  # Change to "light" if using e-ink-light-scheme.yaml
    
    # Enable targets for applications that need explicit theming
    targets = {
      btop.enable = true;
      lazygit.enable = true;
      bat.enable = true;
      fzf.enable = true;
    };
  };
}

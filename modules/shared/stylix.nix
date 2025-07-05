# Shared Stylix configuration for both Darwin and NixOS
{ config, pkgs, lib, ... }:

{
  stylix = {
    enable = true;
    
    # Base16 color scheme - you can change this to any base16 scheme
    base16Scheme = "${pkgs.base16-schemes}/share/themes/gruvbox-dark-medium.yaml";
    
    # You can also use a custom image to generate colors
    # image = ./path/to/your/wallpaper.jpg;
    
    # Fonts configuration
    fonts = {
      monospace = {
        package = pkgs.nerdfonts.override { fonts = [ "JetBrainsMono" ]; };
        name = "JetBrainsMono Nerd Font Mono";
      };
      sansSerif = {
        package = pkgs.dejavu_fonts;
        name = "DejaVu Sans";
      };
      serif = {
        package = pkgs.dejavu_fonts;
        name = "DejaVu Serif";
      };
      
      sizes = {
        applications = 12;
        terminal = 13;
        desktop = 11;
        popups = 10;
      };
    };
    
    # Cursor configuration
    cursor = {
      package = pkgs.bibata-cursors;
      name = "Bibata-Modern-Classic";
      size = 24;
    };
    
    # Opacity settings
    opacity = {
      applications = 1.0;
      terminal = 0.9;
      desktop = 1.0;
      popups = 1.0;
    };
    
    # Polarity (dark/light theme)
    polarity = "dark";
    
    # Target applications - you can disable specific apps if needed
    targets = {
      # Terminal applications
      alacritty.enable = true;
      foot.enable = true;
      
      # Editors
      vim.enable = true;
      neovim.enable = true;
      
      # Desktop environments (NixOS only)
      gnome.enable = lib.mkDefault false;
      kde.enable = lib.mkDefault false;
      
      # Browsers
      firefox.enable = true;
      
      # Other applications
      waybar.enable = true;
      rofi.enable = true;
      fuzzel.enable = true;
      
      # Development tools
      bat.enable = true;
      fzf.enable = true;
      
      # System components (NixOS only)
      grub.enable = lib.mkDefault false;
      plymouth.enable = lib.mkDefault false;
    };
  };
}
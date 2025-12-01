{ lib, config, pkgs, ... }:
{
  imports = [
    ../../system/login.nix
  ];

  programs.hyprland.enable = true;

  environment.etc."wallpaper.jpg".source = ../../assets/wallpaper.jpg;

  home-manager.users.bdsqqq = { config, pkgs, lib, inputs, ... }: {
    imports = [
      ../../user/hyprland.nix
    ];
    
    # install a cursor theme (apple_cursor is macOS-style)
    home.pointerCursor = {
      name = "macOS";
      package = pkgs.apple-cursor;
      size = 24;
      gtk.enable = true;
      x11.enable = true;
    };
  };
}

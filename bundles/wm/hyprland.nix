{ lib, config, pkgs, ... }:
{
  imports = [
    ../../system/login.nix
  ];

  programs.hyprland.enable = true;
  
  # portal-gtk provides Settings/Appearance interface for theme detection
  # (ghostty, electron apps, etc. query this for light/dark preference)
  xdg.portal = {
    enable = true;
    extraPortals = [ pkgs.xdg-desktop-portal-gtk ];
  };

  environment.etc."wallpaper.jpg".source = ../../assets/wallpaper.jpg;

  home-manager.users.bdsqqq = { config, pkgs, lib, inputs, ... }: {
    imports = [
      ../../user/hyprland.nix
    ];
    # cursor is managed by stylix
  };
}

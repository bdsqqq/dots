{ lib, config, pkgs, ... }:
{
  imports = [
    ../../system/login.nix
  ];

  programs.hyprland.enable = true;
  programs.dconf.enable = true;
  
  # portal setup for theme detection (apps query org.freedesktop.portal.Settings)
  xdg.portal = {
    enable = true;
    xdgOpenUsePortal = true;
    extraPortals = [
      pkgs.xdg-desktop-portal-hyprland
      pkgs.xdg-desktop-portal-gtk
    ];
    config = {
      common = {
        default = [ "hyprland" "gtk" ];
        "org.freedesktop.impl.portal.Settings" = [ "gtk" ];
      };
    };
  };
  
  environment.sessionVariables.XDG_CURRENT_DESKTOP = "Hyprland";

  environment.etc."wallpaper.jpg".source = ../../assets/wallpaper.jpg;

  home-manager.users.bdsqqq = { config, pkgs, lib, inputs, ... }: {
    imports = [
      ../../user/hyprland.nix
    ];
    # cursor is managed by stylix
  };
}

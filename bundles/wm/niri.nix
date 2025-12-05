{ lib, config, pkgs, ... }:
{
  imports = [
    ../../system/login.nix
  ];

  programs.niri.enable = true;
  programs.dconf.enable = true;
  
  # portal setup for theme detection
  xdg.portal = {
    enable = true;
    xdgOpenUsePortal = true;
    extraPortals = [
      pkgs.xdg-desktop-portal-gnome
      pkgs.xdg-desktop-portal-gtk
    ];
    config = {
      common = {
        default = [ "gnome" "gtk" ];
        "org.freedesktop.impl.portal.Settings" = [ "gtk" ];
      };
    };
  };
  
  environment.sessionVariables.XDG_CURRENT_DESKTOP = "niri";

  environment.etc."wallpaper.jpg".source = ../../assets/wallpaper.jpg;

  home-manager.users.bdsqqq = { config, pkgs, lib, inputs, ... }: {
    imports = [
      ../../user/niri.nix
    ];
  };
}

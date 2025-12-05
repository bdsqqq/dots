{ lib, config, pkgs, ... }:
{
  imports = [
    ../../system/login.nix
  ];

  programs.hyprland.enable = true;
  
  # portal-gtk needs system-level dconf to read gsettings. home-manager's
  # dconf.enable only sets up user-level config; this enables the system
  # service that portal-gtk depends on.
  programs.dconf.enable = true;
  
  # portal configuration for system-wide theme detection. apps query
  # org.freedesktop.portal.Settings for color-scheme preference. without
  # explicit config, xdg-desktop-portal auto-detects backends unreliably
  # on non-GNOME desktops.
  xdg.portal = {
    enable = true;
    xdgOpenUsePortal = true;
    extraPortals = [
      pkgs.xdg-desktop-portal-hyprland
      pkgs.xdg-desktop-portal-gtk
    ];
    # force gtk backend for Settings interface; hyprland portal doesn't
    # implement it. without this, apps see no color-scheme preference.
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

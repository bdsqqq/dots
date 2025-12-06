{ lib, config, pkgs, ... }:
{
  imports = [
    ../../system/login.nix
  ];

  programs.niri.enable = true;
  # use nixpkgs niri to avoid build issues with niri-flake's unstable version
  programs.niri.package = pkgs.niri;
  programs.dconf.enable = true;
  
  # portal setup for niri session (config is per-desktop, not global)
  xdg.portal = {
    enable = true;
    xdgOpenUsePortal = true;
    extraPortals = [
      pkgs.xdg-desktop-portal-gnome
      pkgs.xdg-desktop-portal-gtk
    ];
    config = {
      niri = {
        default = [ "gnome" "gtk" ];
        "org.freedesktop.impl.portal.Settings" = [ "gtk" ];
      };
    };
  };
  
  # XDG_CURRENT_DESKTOP is set by the session desktop file when niri starts

  environment.etc."wallpaper.jpg".source = ../../assets/wallpaper.jpg;

  home-manager.users.bdsqqq = { config, pkgs, lib, inputs, ... }: {
    imports = [
      ../../user/niri.nix
    ];
  };
}

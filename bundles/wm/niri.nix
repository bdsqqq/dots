{ lib, config, pkgs, inputs, ... }: {
  imports = [ ../../system/login.nix ];

  programs.niri.enable = true;
  programs.niri.package = inputs.niri.packages.${pkgs.stdenv.hostPlatform.system}.niri-unstable;
  programs.dconf.enable = true;

  # portal setup for niri session (config is per-desktop, not global)
  xdg.portal = {
    enable = true;
    xdgOpenUsePortal = true;
    extraPortals =
      [ pkgs.xdg-desktop-portal-gnome pkgs.xdg-desktop-portal-gtk ];
    config = {
      niri = {
        default = [ "gnome" "gtk" ];
        "org.freedesktop.impl.portal.Settings" = [ "gtk" ];
      };
    };
  };

  # XDG_CURRENT_DESKTOP is set by the session desktop file when niri starts

  environment.etc."wallpaper.jpg".source =
    ../../assets/wallpaper_without_mask.jpg;

  specialisation.greeter-quickshell.configuration = {
    my.login.greeter = "quickshell";
    system.nixos.tags = [ "greeter-quickshell" ];
  };

  home-manager.users.bdsqqq = { config, pkgs, lib, inputs, ... }: {
    imports = [ ../../user/niri.nix ];
  };
}

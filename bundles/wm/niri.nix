{ lib, config, pkgs, inputs, ... }: {
  imports = [ ../../system/login.nix ];

  programs.niri.enable = true;
  programs.niri.package = inputs.niri.packages.${pkgs.stdenv.hostPlatform.system}.niri-unstable;
  programs.dconf.enable = true;

  boot.kernelModules = lib.mkIf (config.networking.hostName == "lgo-z2e") [ "uinput" ];
  services.udev.extraRules = lib.mkIf (config.networking.hostName == "lgo-z2e") ''
    KERNEL=="uinput", MODE="0660", GROUP="input", OPTIONS+="static_node=uinput"
  '';

  # portal setup for niri session (config is per-desktop, not global)
  xdg.portal = {
    enable = true;
    xdgOpenUsePortal = true;
    extraPortals = [
      pkgs.xdg-desktop-portal-gnome
      pkgs.xdg-desktop-portal-gtk
      pkgs.xdg-desktop-portal-termfilechooser
    ];
    config = {
      niri = {
        default = [ "gnome" "gtk" ];
        "org.freedesktop.impl.portal.FileChooser" = [ "termfilechooser" ];
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

  home-manager.users.bdsqqq = { config, pkgs, lib, inputs, ... }:
    let
      yaziFileChooser = pkgs.writeShellScript "yazi-file-chooser" ''
        set -eu

        multiple="$1"
        directory="$2"
        save="$3"
        path="$4"
        out="$5"

        if [ "$save" = "1" ]; then
          set -- --chooser-file="$out" "$path"
        elif [ "$directory" = "1" ]; then
          set -- --chooser-file="$out" --cwd-file="$out.1" "$path"
        elif [ "$multiple" = "1" ]; then
          set -- --chooser-file="$out" "$path"
        else
          set -- --chooser-file="$out" "$path"
        fi

        ${pkgs.ghostty}/bin/ghostty --title=termfilechooser -e ${pkgs.yazi}/bin/yazi "$@"

        if [ "$directory" = "1" ]; then
          if [ ! -s "$out" ] && [ -s "$out.1" ]; then
            cat "$out.1" > "$out"
          fi
          rm -f "$out.1"
        fi
      '';
    in {
      imports = [ ../../user/niri.nix ];

      xdg.configFile."xdg-desktop-portal-termfilechooser/config".text = ''
        [filechooser]
        cmd=${yaziFileChooser}
        default_dir=$HOME
        open_mode=suggested
        save_mode=suggested
      '';
    };
}

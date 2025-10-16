{ lib, config, pkgs, ... }:
{
  home-manager.users.bdsqqq = { config, pkgs, lib, ... }: {
    home.packages = with pkgs; [
      _1password-gui
      _1password-cli
      docker
      blockbench
      vscode
      blender
      obsidian
      spicetify-cli
      transmission_4
      rclone
      qpdf
    ] ++ lib.optionals pkgs.stdenv.isDarwin [
      tableplus
      iina
    ] ++ lib.optionals (!pkgs.stdenv.isDarwin) [
      dbeaver-bin
      vlc
      xwayland-satellite
      fuzzel
      blueman
      pavucontrol
      playerctl
      brightnessctl
      networkmanager_dmenu
    ];
  };
}



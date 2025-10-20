{ lib, hostSystem ? null, ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
in
{
  home-manager.users.bdsqqq = { pkgs, ... }: {
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
      ghostty
    ] ++ lib.optionals isDarwin [
      tableplus
      iina
    ] ++ lib.optionals (!isDarwin) [
      dbeaver-bin
      vlc
      xwayland-satellite
      fuzzel
      blueman
      pavucontrol
      playerctl
      brightnessctl
      networkmanager_dmenu
      
      # TUI utilities for desktop
      bluetuith
      pulsemixer
      lnav
      bandwhich
      iotop
      systemctl-tui
      dust
      procs
      pyprland
    ];
  };
}



{ lib, hostSystem ? null, ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
in
{
  home-manager.users.bdsqqq = { pkgs, ... }: {
    home.packages = with pkgs; [
      docker
      blockbench
      vscode
      blender
      obsidian
      transmission_4
      rclone
      qpdf
    ] ++ lib.optionals isDarwin [
      iina
    ] ++ lib.optionals (!isDarwin) [
      _1password-gui
      _1password-cli
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



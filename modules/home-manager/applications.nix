{ config, pkgs, lib, isDarwin ? false, ... }:

{
  home.packages = with pkgs; [
    _1password-gui
    _1password-cli

    docker
    blockbench

    obsidian
    prismlauncher
    spicetify-cli
    spotify-player
    transmission_4
    rclone
  ] ++ lib.optionals isDarwin [
    # macOS-only apps
    tableplus
    iina
  ] ++ lib.optionals (!isDarwin) [
    # Linux alternatives
    dbeaver-bin  # Alternative to TablePlus
    vlc      # Alternative to iina
  ];
}

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
    opencode
    firefox
  ] ++ lib.optionals isDarwin [
    # macOS-only apps
    tableplus
    iina
    # Use macOS native Terminal.app or iTerm2 instead of ghostty on Darwin
  ] ++ lib.optionals (!isDarwin) [
    # Linux-specific apps
    ghostty  # Terminal emulator (broken on Darwin)
    steam    # Gaming platform (Linux-specific in nixpkgs)
    dbeaver-bin  # Alternative to TablePlus
    vlc      # Alternative to iina
    xwayland-satellite  # For running X11 apps like Steam on Niri
  ];
}

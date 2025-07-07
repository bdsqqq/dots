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
    # spotify-player # Configured in development.nix via programs.spotify-player
    transmission_4
    rclone
    opencode
    firefox
  ] ++ lib.optionals isDarwin [
    # macOS-only apps
    tableplus
    iina
    # ghostty unavailable on Darwin in nixpkgs - use homebrew version
  ] ++ lib.optionals (!isDarwin) [
    # Linux-specific apps
    ghostty  # Terminal emulator
    steam    # Gaming platform (Linux-specific in nixpkgs)
    dbeaver-bin  # Alternative to TablePlus
    vlc      # Alternative to iina
    xwayland-satellite  # For running X11 apps like Steam on Niri
  ];
}

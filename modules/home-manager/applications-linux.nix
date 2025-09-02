{ config, pkgs, lib, isDarwin ? false, ... }:

{
  home.packages = with pkgs; [
    # Cross-platform applications
    _1password-cli
    docker
    rclone
    qpdf
    # spotify-player # Configured in workbench.nix via programs.spotify-player
  ] ++ lib.optionals isDarwin [
    # macOS-only apps
    tableplus
    iina
    # ghostty unavailable on Darwin in nixpkgs - use homebrew version
  ] ++ lib.optionals (!isDarwin) [
    # Linux-specific apps
    _1password-gui
    blockbench
    blender
    obsidian
    spicetify-cli
    transmission_4
    ghostty  # Terminal emulator
    dbeaver-bin  # Alternative to TablePlus
    vlc      # Alternative to iina
    xwayland-satellite  # For running X11 apps like Steam on Niri
    
    # System tray and menu functionality
    fuzzel   # Application launcher and menu system for Waybar
    blueman  # Bluetooth manager with GUI
    pavucontrol  # PulseAudio volume control
    
    # Additional system utilities for daily use
    playerctl  # Media player control
    brightnessctl  # Brightness control
    
    # Network management
    networkmanager_dmenu  # NetworkManager interface for dmenu/fuzzel
  ];
}

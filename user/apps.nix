{ lib, inputs, hostSystem ? null, headMode ? "graphical", ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
in
lib.mkIf (headMode == "graphical") {
  home-manager.users.bdsqqq = { pkgs, ... }: {
    home.packages = with pkgs; [
      docker
      blockbench
      vscode
      # blender  # disabled: triggers OpenUSD compile with cudaSupport
      obsidian
      transmission_4
      rclone
      qpdf
      inputs.lnr.packages.${hostSystem}.default
    ] ++ lib.optionals isDarwin [
      iina
    ] ++ lib.optionals (!isDarwin) [
      inputs.cursor.packages.x86_64-linux.default
      _1password-gui
      _1password-cli
      dbeaver-bin
      vlc
      imv
      nautilus
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



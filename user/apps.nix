{ lib, inputs, hostSystem ? null, headMode ? "graphical", ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
in
lib.mkIf (headMode == "graphical") {
  home-manager.users.bdsqqq = { pkgs, ... }: {
    home.packages = with pkgs; [
      blockbench
      vscode
      code-cursor
      # blender  # disabled: triggers OpenUSD compile with cudaSupport
      obsidian
      rclone
      qpdf
      inputs.lnr.packages.${hostSystem}.default
    ] ++ lib.optionals isDarwin [
      iina
    ] ++ lib.optionals (!isDarwin) [
      transmission_4  # fmt-9.1.0 fails to compile on darwin with newer clang
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



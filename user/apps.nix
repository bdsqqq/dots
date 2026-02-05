{ lib, inputs, hostSystem ? null, headMode ? "graphical", ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
in
lib.mkIf (headMode == "graphical") {
  home-manager.users.bdsqqq = { pkgs, ... }: {
    home.packages = with pkgs; [
      blockbench
      vscode
      # blender  # disabled: triggers OpenUSD compile with cudaSupport
      obsidian
      transmission_4
      rclone
      qpdf
      # inputs.lnr.packages.${hostSystem}.default  # CANARY: testing schema-codegen branch (PR #20)
    ] ++ [
      # Canary lnr binary - remove after PR #20 is merged
      (pkgs.runCommand "lnr-canary" { } ''
        mkdir -p $out/bin
        ln -s /Users/bdsqqq/www/lnr/schema-codegen/lnr $out/bin/lnr
      '')
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



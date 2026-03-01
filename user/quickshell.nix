{ lib, pkgs, hostSystem ? null, ... }:

let
  isLinux = lib.hasInfix "linux" hostSystem;
  quickshellDir = "commonplace/01_files/nix/user/quickshell";
in
if !isLinux then {} else {
  home-manager.users.bdsqqq = { config, ... }: {
    home.packages = [ pkgs.quickshellWrapped ];

    # no-hop symlink: directly link to working tree for live-reload
    # why: mkOutOfStoreSymlink still creates a store hop; this doesn't.
    home.activation.quickshellLiveReload = lib.hm.dag.entryAfter ["writeBoundary"] ''
      ln -sfn "${config.home.homeDirectory}/${quickshellDir}" $HOME/.config/quickshell
    '';

    # enable sd-switch so home-manager restarts services on config change
    systemd.user.startServices = "sd-switch";

    # systemd user service for quickshell - restarts when nix config changes
    systemd.user.services.quickshell = {
      Unit = {
        Description = "Quickshell status bar and shell components";
        After = [ "graphical-session.target" ];
        PartOf = [ "graphical-session.target" ];
        # restart when nix config changes (quickshell has native live-reload for QML files)
        X-Restart-Triggers = [ "${config.home.homeDirectory}/${quickshellDir}" ];
      };
      Service = {
        Type = "simple";
        ExecStart = "${pkgs.quickshellWrapped}/bin/quickshell";
        Restart = "on-failure";
        RestartSec = 2;
      };
      Install = {
        WantedBy = [ "graphical-session.target" ];
      };
    };
  };
}

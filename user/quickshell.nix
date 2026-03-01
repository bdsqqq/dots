{ lib, pkgs, hostSystem ? null, ... }:

let
  isLinux = lib.hasInfix "linux" hostSystem;
  quickshellDir = ./quickshell;
in
if !isLinux then {} else {
  home-manager.users.bdsqqq = { config, ... }: {
    home.packages = [ pkgs.quickshellWrapped ];

    # symlink entire quickshell directory for live-reload (vite-speed feedback)
    xdg.configFile."quickshell".source = config.lib.file.mkOutOfStoreSymlink quickshellDir;

    # enable sd-switch so home-manager restarts services on config change
    systemd.user.startServices = "sd-switch";

    # systemd user service for quickshell - restarts when nix config changes
    systemd.user.services.quickshell = {
      Unit = {
        Description = "Quickshell status bar and shell components";
        After = [ "graphical-session.target" ];
        PartOf = [ "graphical-session.target" ];
        # restart when nix config changes (quickshell has native live-reload for QML files)
        X-Restart-Triggers = [ "${config.xdg.configFile."quickshell".source}" ];
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

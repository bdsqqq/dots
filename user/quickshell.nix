{ lib, pkgs, hostSystem ? null, ... }:

let
  isLinux = lib.hasInfix "linux" hostSystem;

  quickshellConfig = {
    "quickshell/shell.qml" = {
      source = ./quickshell/shell.qml;
    };

    "quickshell/Bar.qml" = {
      source = ./quickshell/Bar.qml;
    };
    "quickshell/ScreenCorners.qml" = {
      source = ./quickshell/ScreenCorners.qml;
    };
    "quickshell/NiriState.qml" = {
      source = ./quickshell/NiriState.qml;
    };
    "quickshell/NiriWorkspacesLoader.qml" = {
      source = ./quickshell/NiriWorkspacesLoader.qml;
    };
    "quickshell/NotificationItem.qml" = {
      source = ./quickshell/NotificationItem.qml;
    };
    "quickshell/NotificationPopups.qml" = {
      source = ./quickshell/NotificationPopups.qml;
    };
    "quickshell/ControlCenter.qml" = {
      source = ./quickshell/ControlCenter.qml;
    };
    "quickshell/BrightnessModule.qml" = {
      source = ./quickshell/BrightnessModule.qml;
    };
    "quickshell/BluetoothModule.qml" = {
      source = ./quickshell/BluetoothModule.qml;
    };
    "quickshell/NetworkModule.qml" = {
      source = ./quickshell/NetworkModule.qml;
    };
    "quickshell/ControlCenterBackdrop.qml" = {
      source = ./quickshell/ControlCenterBackdrop.qml;
    };
  };

in
if !isLinux then {} else {
  home-manager.users.bdsqqq = { config, ... }: {
    home.packages = [ pkgs.quickshellWrapped ];
    xdg.configFile = quickshellConfig;
    
    # systemd user service for quickshell - restarts on QML config change
    systemd.user.services.quickshell = {
      Unit = {
        Description = "Quickshell status bar and shell components";
        After = [ "graphical-session.target" ];
        PartOf = [ "graphical-session.target" ];
        # restart when any QML file changes (convert paths to strings)
        X-Restart-Triggers = lib.attrValues (lib.mapAttrs (name: value: "${config.xdg.configFile.${name}.source}") quickshellConfig);
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

{ lib, pkgs, inputs, hostSystem ? null, ... }:

let
  isLinux = lib.hasInfix "linux" hostSystem;

  quickshellPkg = inputs.quickshell.packages.${hostSystem}.default;

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
    "quickshell/NiriWorkspacesLoader.qml" = {
      source = ./quickshell/NiriWorkspacesLoader.qml;
    };
    "quickshell/NotificationItem.qml" = {
      source = ./quickshell/NotificationItem.qml;
    };
    "quickshell/NotificationPopups.qml" = {
      source = ./quickshell/NotificationPopups.qml;
    };
  };

in
if !isLinux then {} else {
  home-manager.users.bdsqqq = { ... }: {
    home.packages = [ quickshellPkg ];
    xdg.configFile = quickshellConfig;
  };
}

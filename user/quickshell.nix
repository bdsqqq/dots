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
  home-manager.users.bdsqqq = { ... }: {
    home.packages = [ quickshellPkg ];
    xdg.configFile = quickshellConfig;
  };
}

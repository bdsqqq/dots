# quickshell package with runtime dependencies baked in.
#
# QML files use bare binary names (e.g., "bluetoothctl") for hot-reload
# during development. this wrapper ensures those binaries are in PATH
# when quickshell runs from spawn-at-startup, which executes before
# home-manager sets up the user's PATH.
#
# contract: if a QML file calls a binary via Process, add it here.

{ pkgs, lib, inputs, hostSystem }:

let
  quickshellPkg = inputs.quickshell.packages.${hostSystem}.default;

  runtimeDeps = with pkgs; [
    bluez           # bluetoothctl (BluetoothModule.qml)
    networkmanager  # nmcli (NetworkModule.qml)
    brightnessctl   # brightnessctl (BrightnessModule.qml)
  ];

in pkgs.symlinkJoin {
  name = "quickshell-wrapped";
  paths = [ quickshellPkg ];
  buildInputs = [ pkgs.makeWrapper ];
  postBuild = ''
    wrapProgram $out/bin/quickshell \
      --prefix PATH : ${lib.makeBinPath runtimeDeps}
  '';
}

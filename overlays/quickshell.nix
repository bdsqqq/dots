# quickshell wrapped with runtime deps for QML Process calls.
#
# QML files use bare binary names for hot-reload during development.
# spawn-at-startup runs before home-manager sets up PATH, so we bake
# the deps into the wrapper.
#
# contract: if a QML file calls a binary via Process, add it here.
inputs: final: prev: {
  quickshellWrapped = 
    let
      quickshellPkg = inputs.quickshell.packages.${final.stdenv.hostPlatform.system}.default;
      runtimeDeps = with final; [
        bluez           # bluetoothctl (BluetoothModule.qml)
        networkmanager  # nmcli (NetworkModule.qml)
        brightnessctl   # brightnessctl (BrightnessModule.qml)
      ];
    in final.symlinkJoin {
      name = "quickshell-wrapped";
      paths = [ quickshellPkg ];
      buildInputs = [ final.makeWrapper ];
      postBuild = ''
        wrapProgram $out/bin/quickshell \
          --prefix PATH : ${final.lib.makeBinPath runtimeDeps}
      '';
    };
}

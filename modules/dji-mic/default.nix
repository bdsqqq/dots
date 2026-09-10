{
  lib,
  pkgs,
  hostSystem ? null,
  ...
}:

let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  stablePath = "/usr/local/bin/dji-mic-hid-remap";
  djiMicHidRemap = pkgs.stdenv.mkDerivation {
    pname = "dji-mic-hid-remap";
    version = "1";
    src = ./dji-mic-hid-remap.c;
    dontUnpack = true;

    buildPhase = ''
      runHook preBuild
      $CC -std=c11 -fblocks -Wall -Wextra -Werror \
        "$src" -framework ApplicationServices -framework Carbon \
        -o dji-mic-hid-remap
      runHook postBuild
    '';

    doCheck = true;
    checkPhase = ''
      runHook preCheck
      ./dji-mic-hid-remap --self-test
      runHook postCheck
    '';

    installPhase = ''
      runHook preInstall
      install -Dm755 dji-mic-hid-remap "$out/bin/dji-mic-hid-remap"
      runHook postInstall
    '';
  };
in
lib.mkIf isDarwin {
  system.activationScripts.extraActivation.text = ''
    mkdir -p /usr/local/bin
    stage="$(mktemp /usr/local/.dji-mic-hid-remap.XXXXXX)"
    cleanup_dji_mic_hid_remap() { rm -f "$stage"; }
    trap cleanup_dji_mic_hid_remap EXIT

    install -m 0755 ${djiMicHidRemap}/bin/dji-mic-hid-remap "$stage"
    # The stable path lets macOS present one Accessibility entry. Because the
    # signature is ad hoc, a changed helper may still require renewed approval.
    /usr/bin/codesign --force --sign - \
      --identifier com.bdsqqq.dji-mic-hid-remap "$stage"

    if [ ! -x ${stablePath} ] || ! cmp -s "$stage" ${stablePath}; then
      mv -f "$stage" ${stablePath}
    fi

    cleanup_dji_mic_hid_remap
    trap - EXIT
  '';

  home-manager.users.bdsqqq = { config, ... }: {
    home.file.".local/state/log/dji-mic-hid-remap/.keep".text = "";

    launchd.agents.dji-mic-hid-remap = {
      enable = true;
      config = {
        ProgramArguments = [ stablePath ];
        EnvironmentVariables.DJI_MIC_HID_REMAP_GENERATION = "${djiMicHidRemap}";
        RunAtLoad = true;
        KeepAlive.SuccessfulExit = false;
        ProcessType = "Background";
        ThrottleInterval = 10;

        LaunchEvents."com.apple.iokit.matching" = {
          "com.bdsqqq.dji-mic-hid-remap.connected" = {
            IOMatchLaunchStream = true;
            IONotificationType = "IOServicePublish";
            IOProviderClass = "IOHIDEventService";
            VendorID = 11427;
            ProductID = 16401;
          };
        };

        StandardOutPath = "${config.home.homeDirectory}/.local/state/log/dji-mic-hid-remap/agent.log";
        StandardErrorPath = "${config.home.homeDirectory}/.local/state/log/dji-mic-hid-remap/agent.log";
      };
    };
  };
}

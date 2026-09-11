{
  lib,
  pkgs,
  hostSystem ? null,
  ...
}:

let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  signingIdentity = "Apple Development: igorbedesqui@gmail.com (6PM95FYLZC)";
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
  home-manager.users.bdsqqq =
    { config, lib, ... }:
    let
      stablePath = "${config.home.homeDirectory}/.local/libexec/dji-mic-hid-remap";
    in
    {
      home.file.".local/state/log/dji-mic-hid-remap/.keep".text = "";

      # Sign outside the Nix store so TCC sees a stable path and certificate-backed
      # designated requirement instead of a new ad-hoc cdhash after every rebuild.
      home.activation.installDjiMicHidRemap =
        lib.hm.dag.entryBetween [ "setupLaunchAgents" ] [ "writeBoundary" ]
          ''
            if [[ -v DRY_RUN ]]; then
              echo "would install and sign ${stablePath}"
            else
              (
                generation=${lib.escapeShellArg "${stablePath}.generation"}
                if [[ -x ${lib.escapeShellArg stablePath} ]] \
                  && [[ "$(/bin/cat "$generation" 2>/dev/null || true)" == ${lib.escapeShellArg "${djiMicHidRemap}"} ]] \
                  && /usr/bin/codesign --verify --strict ${lib.escapeShellArg stablePath} 2>/dev/null; then
                  exit 0
                fi

                mkdir -p ${lib.escapeShellArg (builtins.dirOf stablePath)}
                stage="$(mktemp ${lib.escapeShellArg "${builtins.dirOf stablePath}/.dji-mic-hid-remap.XXXXXX"})"
                cleanup_dji_mic_hid_remap() { rm -f "$stage"; }
                trap cleanup_dji_mic_hid_remap EXIT

                install -m 0755 ${djiMicHidRemap}/bin/dji-mic-hid-remap "$stage"
                /usr/bin/codesign --force --timestamp=none \
                  --sign ${lib.escapeShellArg signingIdentity} \
                  --identifier com.bdsqqq.dji-mic-hid-remap "$stage"
                /usr/bin/codesign --verify --strict "$stage"
                mv -f "$stage" ${lib.escapeShellArg stablePath}
                printf '%s\n' ${lib.escapeShellArg "${djiMicHidRemap}"} >"$generation"
              )
            fi
          '';

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

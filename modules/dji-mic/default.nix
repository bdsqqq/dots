{
  lib,
  pkgs,
  hostSystem ? null,
  ...
}:

let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  djiMicHidRemap = pkgs.stdenv.mkDerivation {
    pname = "dji-mic-hid-remap";
    version = "1";
    src = ./dji-mic-hid-remap.c;
    dontUnpack = true;

    buildPhase = ''
      runHook preBuild
      $CC -std=c11 -fblocks -Wall -Wextra -Werror "$src" -o dji-mic-hid-remap
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      install -Dm755 dji-mic-hid-remap "$out/bin/dji-mic-hid-remap"
      runHook postInstall
    '';
  };
in
lib.mkIf isDarwin {
  home-manager.users.bdsqqq = { config, ... }: {
    launchd.agents.dji-mic-hid-remap = {
      enable = true;
      config = {
        ProgramArguments = [ "${djiMicHidRemap}/bin/dji-mic-hid-remap" ];
        RunAtLoad = true;
        KeepAlive.Crashed = true;
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

        StandardOutPath = "${config.home.homeDirectory}/Library/Logs/dji-mic-hid-remap.log";
        StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/dji-mic-hid-remap.log";
      };
    };
  };
}

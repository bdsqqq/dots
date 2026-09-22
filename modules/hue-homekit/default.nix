{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.my.hueHomekit;
  package = pkgs.callPackage ./package.nix { };
  daemonUrl = "http://127.0.0.1:${toString config.my.hueControl.port}";
in
{
  options.my.hueHomekit = {
    enable = lib.mkEnableOption "HomeKit frontend for the Hue BLE daemon";
    interface = lib.mkOption {
      type = lib.types.str;
      default = "en0";
      description = "LAN interface for HomeKit discovery and paired connections.";
    };
  };
  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = config.my.hueControl.enable && config.my.hueControl.runDaemon;
        message = "Hue HomeKit requires the local Hue BLE daemon.";
      }
    ];
    home-manager.users.bdsqqq = { config, lib, ... }: {
      home.packages = [ package ];
      # Local Network settings cannot display or authorize an unregistered app.
      home.activation.registerHueHomekit = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
          -f "${package}/Applications/Hue HomeKit.app"
      '';
      launchd.agents.hue-homekit = {
        enable = true;
        config = {
          ProgramArguments = [
            "${package}/bin/hue-homekit"
            "${config.home.homeDirectory}/Library/Application Support/hue-homekit"
            daemonUrl
            cfg.interface
          ];
          RunAtLoad = true;
          KeepAlive = true;
          LimitLoadToSessionType = "Aqua";
          ProcessType = "Interactive";
          ThrottleInterval = 10;
          Umask = 63;
          StandardOutPath = "${config.home.homeDirectory}/Library/Logs/hue-homekit.log";
          StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/hue-homekit.log";
        };
      };
    };
  };
}

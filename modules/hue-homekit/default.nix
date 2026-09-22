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
  bridges = {
    hue-homekit = {
      name = "Desk Light Bridge";
      port = 51826;
    };
  }
  // lib.mapAttrs' (name: value: lib.nameValuePair "hue-homekit-${name}" value) cfg.additionalBridges;
in
{
  options.my.hueHomekit = {
    enable = lib.mkEnableOption "HomeKit frontend for the Hue BLE daemon";
    interface = lib.mkOption {
      type = lib.types.str;
      default = "en0";
      description = "LAN interface for HomeKit discovery and paired connections.";
    };
    additionalBridges = lib.mkOption {
      default = { };
      description = "Independent pairings for separate Apple homes, sharing the same bulb daemon.";
      type = lib.types.attrsOf (
        lib.types.submodule {
          options = {
            name = lib.mkOption { type = lib.types.str; };
            port = lib.mkOption { type = lib.types.port; };
          };
        }
      );
    };
  };
  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = config.my.hueControl.enable && config.my.hueControl.runDaemon;
        message = "Hue HomeKit requires the local Hue BLE daemon.";
      }
      {
        assertion = lib.allUnique (map (bridge: bridge.port) (lib.attrValues bridges));
        message = "Hue HomeKit bridges must use distinct ports (51826 is reserved for the original bridge).";
      }
    ];
    home-manager.users.bdsqqq = { config, lib, ... }: {
      home.packages = [ package ];
      # Local Network settings cannot display or authorize an unregistered app.
      home.activation.registerHueHomekit = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
          -f "${package}/Applications/Hue HomeKit.app"
      '';
      # Each process needs its own HAP storage; sharing it would share the pairing.
      launchd.agents = lib.mapAttrs (id: bridge: {
        enable = true;
        config = {
          ProgramArguments = [
            "${package}/bin/hue-homekit"
            "${config.home.homeDirectory}/Library/Application Support/${id}"
            daemonUrl
            cfg.interface
            (toString bridge.port)
            bridge.name
          ];
          RunAtLoad = true;
          KeepAlive = true;
          LimitLoadToSessionType = "Aqua";
          ProcessType = "Interactive";
          ThrottleInterval = 10;
          Umask = 63;
          StandardOutPath = "${config.home.homeDirectory}/Library/Logs/${id}.log";
          StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/${id}.log";
        };
      }) bridges;
    };
  };
}

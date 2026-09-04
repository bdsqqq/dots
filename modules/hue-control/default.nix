{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.my.hueControl;
  package = pkgs.callPackage ./package.nix { };
  app = "${package}/Applications/Hue Control.app";
in
{
  options.my.hueControl = {
    enable = lib.mkEnableOption "nearby Hue bulb control";

    port = lib.mkOption {
      type = lib.types.port;
      default = 8756;
      description = "Loopback port for the Hue control service.";
    };

    publishService = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Advertise this host as the native svc:hue provider after commissioning.";
    };

    runDaemon = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Run the host-local BLE daemon in addition to installing the API client.";
    };

    statePath = lib.mkOption {
      type = lib.types.str;
      default = "/Users/bdsqqq/Library/Application Support/hue-control/state.json";
      description = "Host-local CoreBluetooth device enrollment.";
    };
  };

  config = lib.mkIf cfg.enable {
    my.tailnetRegistry.services.hue = lib.mkIf cfg.runDaemon {
      title = "hue";
      description = "nearby Hue bulb control";
      target = "http://127.0.0.1:${toString cfg.port}";
      scheme = "https";
      port = cfg.port;
      healthPath = "/health";
      access.tailnet = "owner";
      tailscaleService.enable = cfg.publishService;
    };

    home-manager.users.bdsqqq = { config, lib, ... }: {
      home.packages = [ package ];
      home.activation.hueControlState = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        mkdir -p ${lib.escapeShellArg (builtins.dirOf cfg.statePath)}
        chmod 700 ${lib.escapeShellArg (builtins.dirOf cfg.statePath)}
      '';

      launchd.agents.hue-control = lib.mkIf cfg.runDaemon {
        enable = true;
        config = {
          ProgramArguments = [
            "${app}/Contents/MacOS/HueControl"
            "${app}/Contents/Resources/hue-control.mjs"
            "--state"
            cfg.statePath
            "--port"
            (toString cfg.port)
          ];
          RunAtLoad = true;
          KeepAlive = true;
          LimitLoadToSessionType = "Aqua";
          ProcessType = "Interactive";
          ThrottleInterval = 10;
          StandardOutPath = "${config.home.homeDirectory}/Library/Logs/hue-control.log";
          StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/hue-control.log";
        };
      };
    };
  };
}

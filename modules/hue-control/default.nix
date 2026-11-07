{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.my.hueControl;
  package = pkgs.callPackage ./package.nix { nodejs = pkgs.nodejs_latest; };
  app = "${package}/Applications/Hue Control.app";
  installedApp = "/Applications/Hue Control.app";
  host = "${package}/bin/hue-host";
  # Do not register the changing ad-hoc payload beside the host-signed app.
  tools = pkgs.runCommand "hue-control-tools" { } ''
    mkdir -p "$out/bin"
    ln -s ${package}/bin/hue "$out/bin/hue"
    ln -s ${package}/bin/hue-host "$out/bin/hue-host"
  '';
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
      readinessPath = "/ready";
      access.tailnet = "owner";
      tailscaleService.enable = cfg.publishService;
    };

    # Private identity material is generated on the host, never in a derivation.
    # Stage/sign/verify before home-manager can launch the new app; reload after it
    # writes the agent plist, even when that plist's stable paths did not change.
    system.activationScripts.preActivation.text = lib.mkIf cfg.runDaemon (lib.mkAfter ''
      ${host} provision
      ${host} install --source ${lib.escapeShellArg app}
    '');
    system.activationScripts.postActivation.text = lib.mkIf cfg.runDaemon (lib.mkOrder 2000 ''
      ${host} activate --uid "$(/usr/bin/id -u bdsqqq)" --port ${toString cfg.port} \
        --plist ${lib.escapeShellArg "${config.users.users.bdsqqq.home}/Library/LaunchAgents/org.nix-community.home.hue-control.plist"}
    '');

    home-manager.users.bdsqqq = { config, lib, ... }: {
      home.packages = [ tools ];
      home.activation.hueControlState = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        mkdir -p ${lib.escapeShellArg (builtins.dirOf cfg.statePath)}
        chmod 700 ${lib.escapeShellArg (builtins.dirOf cfg.statePath)}
      '';

      launchd.agents.hue-control = lib.mkIf cfg.runDaemon {
        enable = true;
        config = {
          ProgramArguments = [
            "${installedApp}/Contents/MacOS/HueControl"
            "${installedApp}/Contents/Resources/hue-control.mjs"
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

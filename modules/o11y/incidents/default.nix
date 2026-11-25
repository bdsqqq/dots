{ config, inputs, lib, pkgs, ... }:
let
  cfg = config.services.axiom-incidents;
  source = "${config.my.paths.commonplace}/01_files/nix/modules/o11y/incidents";
  # darwin hosts report metrics as "<name>.local".
  disks = lib.mapAttrs (_: host: host.config.my.diskAlerts.resolved) inputs.self.nixosConfigurations
    // lib.mapAttrs' (name: host: lib.nameValuePair "${name}.local" host.config.my.diskAlerts.resolved) inputs.self.darwinConfigurations;
  runtimeConfig = pkgs.writeText "axiom-incidents.json" (builtins.toJSON {
    inherit disks;
    # the evaluator runs from the live checkout, which can lag this wrapper; an
    # older evaluator only reads `mounts`. newer ones prefer `disks`.
    mounts = lib.mapAttrs (_: host: builtins.attrNames host.mounts) disks;
    inherit (cfg) externalExpectations;
    rulesPath = "${source}/../monitors.json";
    database = "/var/lib/axiom-incidents/incidents.sqlite";
  });
  runner = pkgs.writeShellApplication {
    name = "axiom-incidents";
    runtimeInputs = [ pkgs.nodejs_latest ];
    text = ''
      export HOST_INCIDENT_CONFIG=${runtimeConfig}
      exec node --experimental-strip-types ${lib.escapeShellArg "${source}/main.ts"} "$@"
    '';
  };
in
{
  options.services.axiom-incidents = {
    enable = lib.mkEnableOption "persistent, measured-recovery host incident notifications";
    externalExpectations = lib.mkOption {
      default = [ ];
      description = "Opt-in readiness and upgrade expectations for explicitly monitored always-on hosts.";
      type = lib.types.listOf (lib.types.submodule {
        options = {
          host = lib.mkOption { type = lib.types.str; };
          metricsHost = lib.mkOption { type = lib.types.str; };
          enabledAt = lib.mkOption { type = lib.types.str; };
          manifestUrl = lib.mkOption { type = lib.types.str; };
          services = lib.mkOption { type = lib.types.listOf lib.types.str; };
        };
      });
    };
  };
  config = lib.mkIf cfg.enable {
    my.o11y.credential.required = true;
    environment.systemPackages = [ runner ];
    systemd.services.axiom-incidents = {
      description = "Evaluate persistent Axiom host incidents";
      wants = [ "network-online.target" ];
      after = [ "network-online.target" ];
      unitConfig.RequiresMountsFor = [ source ];
      serviceConfig = {
        Type = "oneshot";
        User = "bdsqqq";
        Group = "users";
        StateDirectory = "axiom-incidents";
        StateDirectoryMode = "0700";
        UMask = "0077";
        LoadCredential = [
          "query-token:/run/secrets/axiom/personal_token"
          "org-id:/run/secrets/axiom/personal_org_id"
          "ingest-token:/run/secrets/axiom/papertrail_token"
        ];
        ExecStart = "${runner}/bin/axiom-incidents poll";
        TimeoutStartSec = 180;
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectSystem = "strict";
        ProtectHome = true;
      };
    };
    systemd.timers.axiom-incidents = {
      wantedBy = [ "timers.target" ];
      timerConfig = { OnBootSec = "1m"; OnUnitActiveSec = "1m"; AccuracySec = "5s"; };
    };
  };
}

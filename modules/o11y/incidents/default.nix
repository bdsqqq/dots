{ config, inputs, lib, pkgs, ... }:
let
  cfg = config.services.axiom-incidents;
  source = "${config.my.paths.commonplace}/01_files/nix/modules/o11y/incidents";
  allowedMounts = [ "/" "/mnt/storage-01" "/mnt/xfs-vdo" ];
  mounts = lib.mapAttrs
    (_: host: builtins.filter (mount: builtins.elem mount allowedMounts) (builtins.attrNames host.config.fileSystems))
    inputs.self.nixosConfigurations
    // lib.mapAttrs' (name: _: lib.nameValuePair "${name}.local" [ "/System/Volumes/Data" ]) inputs.self.darwinConfigurations;
  runtimeConfig = pkgs.writeText "axiom-incidents.json" (builtins.toJSON {
    inherit mounts;
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
  options.services.axiom-incidents.enable = lib.mkEnableOption "persistent, measured-recovery host incident notifications";
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

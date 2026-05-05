{ lib, pkgs, config, hostSystem ? null, ... }:

let
  cfg = config.services.o11y;
  deployCfg = config.services.axiom-deploy-annotation;
  isLinux = lib.hasInfix "linux" hostSystem;
  isDarwin = lib.hasInfix "darwin" hostSystem;

  homeDir = if isDarwin then "/Users/bdsqqq" else "/home/bdsqqq";
  dataDir =
    if isDarwin then
      "${homeDir}/Library/Application Support/otelcol"
    else
      "/var/lib/otelcol";

  edgeUrl = "https://us-east-1.aws.edge.axiom.co";
  secret = name: "/run/secrets/axiom/${name}";
  defaultEventFiles = if isDarwin then [ ] else [ "/var/lib/papertrail/events/*.jsonl" ];
  eventFiles = cfg.papertrail.eventFiles ++ defaultEventFiles;
  eventFilesYaml = lib.concatMapStringsSep "\n" (path: "      - ${path}") eventFiles;
  linuxUserLogFilesYaml = lib.concatMapStringsSep "\n" (path: "      - ${path}") [
    "${homeDir}/.local/state/**/*.log"
  ];
  darwinLogFilesYaml = lib.concatMapStringsSep "\n" (path: "      - ${path}") [
    "${homeDir}/Library/Logs/**/*.log"
    "/Library/Logs/**/*.log"
    "/var/log/**/*.log"
  ];
  darwinLogExcludeFilesYaml = lib.concatMapStringsSep "\n" (path: "      - ${path}") [
    "${homeDir}/Library/Logs/DiagnosticReports/**"
    "${homeDir}/Library/Logs/Zed/.tmp*"
    "/var/log/asl/**"
    "/var/log/DiagnosticMessages/**"
    "/var/log/powermanagement/**"
  ];
  processScraperYaml =
    "      process:\n"
    + "        mute_process_name_error: true\n"
    + "        mute_process_exe_error: true\n"
    + "        mute_process_io_error: true\n";
  logReceiversYaml =
    if isDarwin then ''
        filelog/darwin_services:
          include:
      ${darwinLogFilesYaml}
          exclude:
      ${darwinLogExcludeFilesYaml}
          include_file_name: true
          include_file_path: true
          start_at: end
          storage: file_storage
          operators:
            - type: regex_parser
              if: 'attributes["log.file.path"] matches "^${homeDir}/Library/Logs/[^/]+/.*[.]log$"'
              parse_from: attributes["log.file.path"]
              regex: '^${homeDir}/Library/Logs/(?P<app>[^/]+)/.*[.]log$'
            - type: add
              if: 'attributes["log.file.path"] matches "^${homeDir}/Library/Logs/"'
              field: attributes.user
              value: bdsqqq
            - type: add
              field: attributes.log_source
              value: file
    '' else ''
        journald:
          directory: /var/log/journal

        filelog/user_logs:
          include:
      ${linuxUserLogFilesYaml}
          include_file_name: true
          include_file_path: true
          start_at: end
          storage: file_storage
          operators:
            - type: add
              field: attributes.user
              value: bdsqqq
            - type: add
              field: attributes.log_source
              value: file

        filelog/papertrail:
          include:
      ${eventFilesYaml}
          start_at: end
          storage: file_storage
          operators:
            - type: json_parser
              parse_from: body
    '';
  logReceivers = if isDarwin then "filelog/darwin_services" else "journald, filelog/user_logs, filelog/papertrail";
  deployDatasetsJson = builtins.toJSON deployCfg.datasets;

  otelcolConfig = pkgs.writeText "otelcol-axiom.yaml" ''
    extensions:
      file_storage:
        directory: ${dataDir}
        create_directory: true

    receivers:
    ${logReceiversYaml}
      otlp:
        protocols:
          http:
            endpoint: 127.0.0.1:4318

      hostmetrics:
        collection_interval: 30s
        scrapers:
          cpu:
          memory:
          disk:
          filesystem:
            exclude_mount_points:
              mount_points:
                - /run/credentials/*
                - /run/secrets
                - /run/secrets/*
                - /run/user/*
              match_type: regexp
          load:
          network:
          paging:
          processes:
          system:
    ${processScraperYaml}
    processors:
      batch:
      memory_limiter:
        check_interval: 5s
        limit_mib: 256
        spike_limit_mib: 64
      resource:
        attributes:
          - key: host.name
            value: ${config.networking.hostName or "unknown"}
            action: upsert

    exporters:
      otlphttp/axiom_logs:
        endpoint: ''${env:AXIOM_URL}
        compression: zstd
        headers:
          authorization: Bearer ''${env:AXIOM_TOKEN_LOGS}
          x-axiom-dataset: papertrail

      otlphttp/axiom_metrics:
        endpoint: ''${env:AXIOM_URL}
        compression: zstd
        headers:
          authorization: Bearer ''${env:AXIOM_TOKEN_METRICS}
          x-axiom-metrics-dataset: host-metrics

      otlphttp/axiom_traces:
        endpoint: ''${env:AXIOM_URL}
        compression: zstd
        headers:
          authorization: Bearer ''${env:AXIOM_TOKEN_LOGS}
          x-axiom-dataset: papertrail-traces

    service:
      telemetry:
        logs:
          level: warn
        metrics:
          readers:
            - periodic:
                exporter:
                  otlp:
                    protocol: http/protobuf
                    endpoint: http://127.0.0.1:4318
      extensions: [file_storage]
      pipelines:
        logs:
          receivers: [${logReceivers}]
          processors: [memory_limiter, resource, batch]
          exporters: [otlphttp/axiom_logs]
        metrics:
          receivers: [hostmetrics, otlp]
          processors: [memory_limiter, resource, batch]
          exporters: [otlphttp/axiom_metrics]
        traces:
          receivers: [otlp]
          processors: [memory_limiter, resource, batch]
          exporters: [otlphttp/axiom_traces]
  '';

  deployAnnotate = pkgs.writeShellScript "axiom-deploy-annotate" ''
    set -euo pipefail

    state_dir=/var/lib/axiom-deploy-annotation
    state_file=$state_dir/last-generation
    axiom_token="$(cat ${secret "personal_token"})"
    axiom_org_id="$(cat ${secret "personal_org_id"})"
    axiom_api="https://api.axiom.co/v2/annotations"
    profile_path=/nix/var/nix/profiles/system

    if [[ ! -L "$profile_path" ]]; then
      echo "axiom-deploy-annotate: system profile not found, skipping"
      exit 0
    fi

    current_gen="$(readlink "$profile_path" | grep -oE '[0-9]+' | tail -1)"
    if [[ -f "$state_file" ]] && [[ "$(cat "$state_file")" == "$current_gen" ]]; then
      echo "axiom-deploy-annotate: gen $current_gen already annotated, skipping"
      exit 0
    fi

    hostname="$(hostname -s)"
    timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    store_path="$(readlink -f "$profile_path")"
    git_rev="$(/run/current-system/sw/bin/nixos-version --configuration-revision 2>/dev/null || true)"
    git_rev="''${git_rev%-dirty}"
    git_rev_short="''${git_rev:0:7}"
    url="${deployCfg.repositoryUrl}/commit/$git_rev"

    payload="$(${pkgs.jq}/bin/jq -n \
      --arg time "$timestamp" \
      --arg type "${deployCfg.annotationType}" \
      --arg title "$hostname gen $current_gen ($git_rev_short)" \
      --arg description "nix generation $current_gen deployed to $hostname\n\ncommit: $git_rev\nstore path: $store_path" \
      --arg url "$url" \
      --argjson datasets '${deployDatasetsJson}' \
      '{time: $time, type: $type, datasets: $datasets, title: $title, description: $description, url: $url}')"

    netrc_file="$(mktemp)"
    trap 'rm -f "$netrc_file"' EXIT
    chmod 600 "$netrc_file"
    echo "machine api.axiom.co login bearer password $axiom_token" > "$netrc_file"

    response="$(curl -s -w "\n%{http_code}" -X POST "$axiom_api" \
      --netrc-file "$netrc_file" \
      -H "Content-Type: application/json" \
      -H "X-Axiom-Org-Id: $axiom_org_id" \
      -d "$payload")" || true
    http_code="$(echo "$response" | tail -1)"

    if [[ "$http_code" -ge 200 && "$http_code" -lt 300 ]]; then
      echo "$current_gen" > "$state_file"
      echo "axiom-deploy-annotate: annotation created for $hostname gen $current_gen"
    else
      echo "axiom-deploy-annotate: axiom api returned $http_code (non-fatal)"
      echo "$response" | head -n -1 >&2
    fi
  '';
in
{
  options.services.o11y = {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Whether to forward host observability data to Axiom.";
    };

    papertrail.eventFiles = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "/var/lib/my-service/events.jsonl" ];
      description = "JSONL event files that OpenTelemetry Collector forwards to the Axiom papertrail dataset.";
    };
  };

  config = lib.mkIf cfg.enable (
    let
      common = {
        sops.secrets = {
          "axiom/personal_url" = {
            sopsFile = ./secrets.yaml;
            key = "personal_url";
            owner = "bdsqqq";
          };
          "axiom/personal_org_id" = {
            sopsFile = ./secrets.yaml;
            key = "personal_org_id";
            owner = "bdsqqq";
          };
          "axiom/personal_token" = {
            sopsFile = ./secrets.yaml;
            key = "personal_token";
            owner = "bdsqqq";
          };
          "axiom/papertrail_token" = {
            sopsFile = ./secrets.yaml;
            key = "papertrail_token";
            owner = "bdsqqq";
          };
          "axiom/host_metrics_token" = {
            sopsFile = ./secrets.yaml;
            key = "host_metrics_token";
            owner = "bdsqqq";
          };
        };

        environment.systemPackages = [ pkgs.opentelemetry-collector-contrib ];
        environment.etc."otelcol/axiom.yaml".source = otelcolConfig;
      };
    in
    if isDarwin then
      lib.mkMerge [
        common
        {
          launchd.daemons.otelcol-axiom = {
            script = ''
              export AXIOM_URL="${edgeUrl}"
              export AXIOM_TOKEN_LOGS="$(cat ${secret "papertrail_token"})"
              export AXIOM_TOKEN_METRICS="$(cat ${secret "host_metrics_token"})"
              exec ${pkgs.opentelemetry-collector-contrib}/bin/otelcol-contrib --config /etc/otelcol/axiom.yaml
            '';
            serviceConfig = {
              Label = "dev.otelcol.axiom";
              RunAtLoad = true;
              StandardOutPath = "${homeDir}/Library/Logs/otelcol-axiom.log";
              StandardErrorPath = "${homeDir}/Library/Logs/otelcol-axiom-error.log";
              UserName = "root";
              GroupName = "wheel";
            };
          };
        }
      ]
    else if isLinux then
      lib.mkMerge [
        common
        {
          systemd.tmpfiles.rules = [
            "d /var/lib/papertrail/events 0750 bdsqqq users -"
            "d /var/lib/otelcol 0750 bdsqqq users -"
            "Z /var/lib/otelcol 0750 bdsqqq users -"
          ];

          systemd.services.vector.enable = lib.mkForce false;
          systemd.services.axiom-deploy-annotation.serviceConfig.ExecStart = lib.mkForce deployAnnotate;

          systemd.services.otelcol-axiom = {
            description = "OpenTelemetry Collector - logs and metrics to Axiom";
            wantedBy = [ "multi-user.target" ];
            restartTriggers = [ otelcolConfig ];
            after = [ "network-online.target" ];
            requires = [ "network-online.target" ];

            script = ''
              export AXIOM_URL="${edgeUrl}"
              export AXIOM_TOKEN_LOGS="$(cat ${secret "papertrail_token"})"
              export AXIOM_TOKEN_METRICS="$(cat ${secret "host_metrics_token"})"
              exec ${pkgs.opentelemetry-collector-contrib}/bin/otelcol-contrib --config /etc/otelcol/axiom.yaml
            '';

            serviceConfig = {
              Type = "simple";
              User = "bdsqqq";
              Group = "users";
              StateDirectory = "otelcol";
              SupplementaryGroups = [ "systemd-journal" ];
              StandardOutput = "null";
              StandardError = "journal";
              Restart = "always";
              RestartSec = "5s";
            };
          };
        }
      ]
    else
      common
  );
}

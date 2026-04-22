# system/vector.nix
{ lib, pkgs, config, hostSystem ? null, ... }:

let
  isLinux = lib.hasInfix "linux" hostSystem;
  isDarwin = lib.hasInfix "darwin" hostSystem;

  homeDir = if isDarwin then "/Users/bdsqqq" else "/home/bdsqqq";
  logsDir = if isDarwin then "${homeDir}/Library/Logs" else "/var/log";
  dataDir = if isDarwin then
    "${homeDir}/Library/Application Support/Vector"
  else
    "/var/lib/vector";

  axiomConfigPath = "${homeDir}/.axiom.toml";

  # dasel v3 dropped the -f flag and leading-dot selector syntax.
  # v2: dasel -f file.toml '.key'   v3: dasel -i toml 'key' < file.toml
  # leading dots cause silent parse failure → empty env vars → InvalidUri(Empty)
  dasel = "${pkgs.dasel}/bin/dasel";

  vectorConfig = if isDarwin then ''
    data_dir = "${dataDir}"

    [sources.host_metrics]
    type = "host_metrics"
    collectors = ["cpu", "memory", "disk", "filesystem", "load", "network"]
    scrape_interval_secs = 30

    [sources.log_files]
    type = "file"
    include = [
      "${logsDir}/syncthing-automerge.log",
      "${logsDir}/vector.log",
      "${logsDir}/vector-error.log"
    ]
    read_from = "end"

    [transforms.parse_logs]
    type = "remap"
    inputs = ["log_files"]
    source = "._time = .timestamp; del(.timestamp); .source_file = .file"

    [sinks.axiom_logs]
    type = "axiom"
    inputs = ["parse_logs"]
    dataset = "papertrail"
    token = "''${AXIOM_TOKEN_LOGS}"
    url = "''${AXIOM_URL_LOGS}"
    org_id = "''${AXIOM_ORG_ID_LOGS}"

    [sinks.axiom_metrics]
    type = "axiom"
    inputs = ["host_metrics"]
    dataset = "host-metrics"
    token = "''${AXIOM_TOKEN_METRICS}"
    url = "''${AXIOM_URL_METRICS}"
    org_id = "''${AXIOM_ORG_ID_METRICS}"
  '' else ''
    data_dir = "${dataDir}"

    [sources.journald]
    type = "journald"
    current_boot_only = false

    [sources.host_metrics]
    type = "host_metrics"
    collectors = ["cpu", "memory", "disk", "filesystem", "load", "network"]
    scrape_interval_secs = 30
    filesystem.mountpoints.excludes = [
      "^/run/credentials/.*$",
      "^/run/secrets$",
      "^/run/secrets/.*$",
      "^/run/user/.*$"
    ]

    [transforms.parse_logs]
    type = "remap"
    inputs = ["journald"]
    source = "._time = .timestamp; del(.timestamp)"

    [sinks.axiom_logs]
    type = "axiom"
    inputs = ["parse_logs"]
    dataset = "papertrail"
    token = "''${AXIOM_TOKEN_LOGS}"
    url = "''${AXIOM_URL_LOGS}"
    org_id = "''${AXIOM_ORG_ID_LOGS}"

    [sinks.axiom_metrics]
    type = "axiom"
    inputs = ["host_metrics"]
    dataset = "host-metrics"
    token = "''${AXIOM_TOKEN_METRICS}"
    url = "''${AXIOM_URL_METRICS}"
    org_id = "''${AXIOM_ORG_ID_METRICS}"
  '';
in if isDarwin then {
  environment.systemPackages = [ pkgs.vector ];

  environment.etc."vector/vector.toml".text = vectorConfig;

  launchd.daemons.vector = {
    script = ''
      # dasel v3: selectors MUST NOT have a leading dot.
      # a leading dot fails silently, producing empty strings for all env vars,
      # which causes axiom sinks to drop every event with InvalidUri(Empty).
      export AXIOM_URL_LOGS="$(${dasel} -i toml 'deployments.personal.url' < "${axiomConfigPath}")"
      export AXIOM_ORG_ID_LOGS="$(${dasel} -i toml 'deployments.personal.org_id' < "${axiomConfigPath}")"
      export AXIOM_TOKEN_LOGS="$(${dasel} -i toml 'deployments.personal.datasets.papertrail.token' < "${axiomConfigPath}")"

      export AXIOM_URL_METRICS="$(${dasel} -i toml 'deployments.personal.url' < "${axiomConfigPath}")"
      export AXIOM_ORG_ID_METRICS="$(${dasel} -i toml 'deployments.personal.org_id' < "${axiomConfigPath}")"
      export AXIOM_TOKEN_METRICS="$(${dasel} -i toml 'deployments.personal.datasets.host-metrics.token' < "${axiomConfigPath}")"

      exec ${pkgs.vector}/bin/vector --config /etc/vector/vector.toml
    '';
    serviceConfig = {
      Label = "dev.vector.vector";
      RunAtLoad = true;
      KeepAlive = { PathState = { "${axiomConfigPath}" = true; }; };
      StandardOutPath = "${logsDir}/vector.log";
      StandardErrorPath = "${logsDir}/vector-error.log";
      UserName = "root";
      GroupName = "wheel";
    };
  };

} else if isLinux then {
  environment.systemPackages = [ pkgs.vector pkgs.dasel ];

  environment.etc."vector/vector.toml".text = vectorConfig;

  systemd.services.vector = {
    description = "Vector - logs and metrics to Axiom";
    wantedBy = [ "multi-user.target" ];
    after = [ "network-online.target" ];
    requires = [ "network-online.target" ];

    script = ''
      # dasel v3: selectors MUST NOT have a leading dot.
      # a leading dot fails silently, producing empty strings for all env vars,
      # which causes axiom sinks to drop every event with InvalidUri(Empty).
      export AXIOM_URL_LOGS="$(${dasel} -i toml 'deployments.personal.url' < "${axiomConfigPath}")"
      export AXIOM_ORG_ID_LOGS="$(${dasel} -i toml 'deployments.personal.org_id' < "${axiomConfigPath}")"
      export AXIOM_TOKEN_LOGS="$(${dasel} -i toml 'deployments.personal.datasets.papertrail.token' < "${axiomConfigPath}")"

      export AXIOM_URL_METRICS="$(${dasel} -i toml 'deployments.personal.url' < "${axiomConfigPath}")"
      export AXIOM_ORG_ID_METRICS="$(${dasel} -i toml 'deployments.personal.org_id' < "${axiomConfigPath}")"
      export AXIOM_TOKEN_METRICS="$(${dasel} -i toml 'deployments.personal.datasets.host-metrics.token' < "${axiomConfigPath}")"

      exec ${pkgs.vector}/bin/vector --config /etc/vector/vector.toml
    '';

    serviceConfig = {
      Type = "simple";
      DynamicUser = true;
      StateDirectory = "vector";
      SupplementaryGroups = [ "systemd-journal" ];
      Restart = "always";
      RestartSec = "5s";
    };
  };

} else
  { }

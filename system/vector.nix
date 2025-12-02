# system/vector.nix
# Vector for logs and metrics → Axiom
# Works on both darwin (launchd) and linux (systemd)
{ lib, pkgs, config, hostSystem ? null, ... }:

let
  isLinux = lib.hasInfix "linux" hostSystem;
  isDarwin = lib.hasInfix "darwin" hostSystem;
  
  homeDir = if isDarwin then "/Users/bdsqqq" else "/home/bdsqqq";
  logsDir = if isDarwin then "${homeDir}/Library/Logs" else "/var/log";
  dataDir = if isDarwin then "${homeDir}/Library/Application Support/Vector" else "/var/lib/vector";
  
  # darwin uses file source for logs; linux uses journald
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
      "${logsDir}/openvscode-server.log",
      "${logsDir}/openvscode-server-error.log",
      "${logsDir}/vector.log",
      "${logsDir}/vector-error.log"
    ]
    read_from = "end"
    
    [transforms.parse_logs]
    type = "remap"
    inputs = ["log_files"]
    source = "._time = .timestamp; del(.timestamp); .source_file = .file"
    
    [transforms.enrich_metrics]
    type = "remap"
    inputs = ["host_metrics"]
    source = "._time = .timestamp; del(.timestamp); .host_type = \"darwin\""
    
    [sinks.axiom_logs]
    type = "axiom"
    inputs = ["parse_logs"]
    dataset = "papertrail"
    token = "''${AXIOM_TOKEN}"
    
    [sinks.axiom_metrics]
    type = "axiom"
    inputs = ["enrich_metrics"]
    dataset = "host-metrics"
    token = "''${AXIOM_TOKEN}"
  '' else ''
    data_dir = "${dataDir}"
    
    [sources.journald]
    type = "journald"
    current_boot_only = false
    
    [sources.host_metrics]
    type = "host_metrics"
    collectors = ["cpu", "memory", "disk", "filesystem", "load", "network"]
    scrape_interval_secs = 30
    
    [transforms.parse_logs]
    type = "remap"
    inputs = ["journald"]
    source = "._time = .timestamp; del(.timestamp)"
    
    [transforms.enrich_metrics]
    type = "remap"
    inputs = ["host_metrics"]
    source = "._time = .timestamp; del(.timestamp); .host_type = \"linux\""
    
    [sinks.axiom_logs]
    type = "axiom"
    inputs = ["parse_logs"]
    dataset = "papertrail"
    token = "''${AXIOM_TOKEN}"
    
    [sinks.axiom_metrics]
    type = "axiom"
    inputs = ["enrich_metrics"]
    dataset = "host-metrics"
    token = "''${AXIOM_TOKEN}"
  '';
in
if isDarwin then {
  environment.systemPackages = [ pkgs.vector ];
  
  environment.etc."vector/vector.toml".text = vectorConfig;
  
  launchd.daemons.vector = {
    script = ''
      export AXIOM_TOKEN="$(cat ${config.sops.secrets.axiom_token.path})"
      exec ${pkgs.vector}/bin/vector --config /etc/vector/vector.toml
    '';
    serviceConfig = {
      Label = "dev.vector.vector";
      RunAtLoad = true;
      KeepAlive = {
        PathState = {
          "${config.sops.secrets.axiom_token.path}" = true;
        };
      };
      StandardOutPath = "${logsDir}/vector.log";
      StandardErrorPath = "${logsDir}/vector-error.log";
      UserName = "root";
      GroupName = "wheel";
    };
  };
  
  sops.secrets.axiom_token = { };
  
} else if isLinux then {
  environment.systemPackages = [ pkgs.vector ];
  
  environment.etc."vector/vector.toml".text = vectorConfig;
  
  sops.secrets.axiom_token = { };
  
  systemd.services.vector = {
    description = "Vector - logs and metrics to Axiom";
    wantedBy = [ "multi-user.target" ];
    after = [ "network-online.target" ];
    requires = [ "network-online.target" ];
    
    serviceConfig = {
      ExecStart = "${pkgs.vector}/bin/vector --config /etc/vector/vector.toml";
      EnvironmentFile = [ config.sops.templates."vector.env".path ];
      DynamicUser = true;
      StateDirectory = "vector";
      SupplementaryGroups = [ "systemd-journal" ];
      Restart = "always";
      RestartSec = "5s";
    };
  };
  
  sops.templates."vector.env".content = ''
    AXIOM_TOKEN=${config.sops.placeholder.axiom_token}
  '';
  
} else { }

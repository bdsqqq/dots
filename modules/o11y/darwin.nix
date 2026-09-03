{ config, lib, pkgs, ... }:

let
  cfg = config.services.o11y;
  homeDir = "/Users/bdsqqq";
  errorLog = "${homeDir}/Library/Logs/darwin-host-metrics-error.log";

  sample = pkgs.writeShellScript "darwin-host-metrics-sample" ''
    set -euo pipefail

    otlp_endpoint=http://127.0.0.1:4318/v1/metrics
    now_nano="$(${pkgs.coreutils}/bin/date +%s%N)"
    tmp="$(${pkgs.coreutils}/bin/mktemp)"
    trap 'rm -f "$tmp"' EXIT
    echo '[]' > "$tmp"

    add_gauge() {
      local name="$1"
      local value="$2"
      local unit="$3"
      local current
      current="$(cat "$tmp")"
      ${pkgs.jq}/bin/jq \
        --arg name "$name" \
        --arg unit "$unit" \
        --argjson value "$value" \
        --arg time "$now_nano" \
        '. + [{name: $name, unit: $unit, gauge: {dataPoints: [{timeUnixNano: $time, asDouble: $value}]}}]' \
        <<< "$current" > "$tmp"
    }

    memory_pressure_output="$(/usr/bin/memory_pressure 2>/dev/null || true)"
    free_percent="$(
      ${pkgs.gawk}/bin/awk -F ': ' \
        '/System-wide memory free percentage/ { gsub(/%/, "", $2); print $2; exit }' \
        <<< "$memory_pressure_output"
    )"
    if [[ "$free_percent" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
      add_gauge "system.macos.memory_pressure.free_percent" "$free_percent" "%"
    fi

    if thermal_output="$(/usr/bin/pmset -g therm 2>/dev/null)"; then
      thermal_warning=1
      performance_warning=1
      cpu_power_warning=1
      ${pkgs.gnugrep}/bin/grep -Fq "No thermal warning level has been recorded" <<< "$thermal_output" \
        && thermal_warning=0
      ${pkgs.gnugrep}/bin/grep -Fq "No performance warning level has been recorded" <<< "$thermal_output" \
        && performance_warning=0
      ${pkgs.gnugrep}/bin/grep -Fq "No CPU power status has been recorded" <<< "$thermal_output" \
        && cpu_power_warning=0

      add_gauge "system.macos.thermal.warning" "$thermal_warning" "1"
      add_gauge "system.macos.performance.warning" "$performance_warning" "1"
      add_gauge "system.macos.cpu_power.warning" "$cpu_power_warning" "1"
    fi

    metrics="$(cat "$tmp")"
    [[ "$metrics" != "[]" ]] || exit 0

    payload="$(${pkgs.jq}/bin/jq -n \
      --arg host "${config.networking.hostName or "unknown"}" \
      --arg service "darwin-host-sampler" \
      --argjson metrics "$metrics" \
      '{resourceMetrics:[{resource:{attributes:[{key:"host.name",value:{stringValue:$host}},{key:"service.name",value:{stringValue:$service}}]},scopeMetrics:[{scope:{name:$service},metrics:$metrics}]}]}')"

    if ! ${lib.getExe pkgs.curl} -fsS -X POST "$otlp_endpoint" \
      -H 'Content-Type: application/json' \
      -d "$payload" >/dev/null; then
      echo "darwin-host-metrics-sample: local otlp receiver unavailable, skipping sample" >&2
      exit 0
    fi
  '';
in
{
  config = lib.mkIf cfg.enable {
    launchd.daemons.darwin-host-metrics = {
      command = sample;
      serviceConfig = {
        RunAtLoad = true;
        StartInterval = 30;
        ProcessType = "Background";
        StandardOutPath = "/dev/null";
        StandardErrorPath = errorLog;
        UserName = "root";
        GroupName = "wheel";
      };
    };

    environment.etc."newsyslog.d/darwin-host-metrics.conf".text = ''
      ${errorLog} root:staff 640 3 10240 * J
    '';
  };
}

{ lib, pkgs, config, hostSystem ? null, ... }:

if !(lib.hasInfix "linux" hostSystem) then { } else
let
  cfg = config.services.hwmon-metrics;

  sample = pkgs.writeShellScript "hwmon-metrics-sample" ''
    set -euo pipefail

    otlp_endpoint=http://127.0.0.1:4318/v1/metrics
    now_nano="$(${pkgs.coreutils}/bin/date +%s%N)"
    tmp="$(mktemp)"
    trap 'rm -f "$tmp"' EXIT
    echo '[]' > "$tmp"

    add_gauge() {
      local name="$1"
      local value="$2"
      local unit="$3"
      local attributes="$4"
      local current
      current="$(cat "$tmp")"
      ${pkgs.jq}/bin/jq \
        --arg name "$name" \
        --arg unit "$unit" \
        --argjson value "$value" \
        --arg time "$now_nano" \
        --argjson attrs "$attributes" \
        '. + [{name: $name, unit: $unit, gauge: {dataPoints: [{timeUnixNano: $time, asDouble: $value, attributes: $attrs}]}}]' \
        <<< "$current" > "$tmp"
    }

    for hwmon in /sys/class/hwmon/hwmon*; do
      [[ -r "$hwmon/name" ]] || continue
      chip="$(cat "$hwmon/name")"
      for input in "$hwmon"/temp*_input; do
        [[ -r "$input" ]] || continue
        sensor="$(basename "$input" _input)"
        label_file="$hwmon/''${sensor}_label"
        label="$sensor"
        [[ -r "$label_file" ]] && label="$(cat "$label_file")"
        celsius="$(${pkgs.gawk}/bin/awk -v v="$(cat "$input")" 'BEGIN { printf "%.3f", v / 1000 }')"
        attrs="$(${pkgs.jq}/bin/jq -n \
          --arg chip "$chip" \
          --arg sensor "$sensor" \
          --arg label "$label" \
          '[{key:"chip",value:{stringValue:$chip}},{key:"sensor",value:{stringValue:$sensor}},{key:"label",value:{stringValue:$label}}]')"
        add_gauge "system.hwmon.temperature.celsius" "$celsius" "Cel" "$attrs"
      done
    done

    metrics="$(cat "$tmp")"
    [[ "$metrics" != "[]" ]] || exit 0

    payload="$(${pkgs.jq}/bin/jq -n \
      --arg host "${config.networking.hostName or "unknown"}" \
      --arg service "hwmon-sysfs-sampler" \
      --argjson metrics "$metrics" \
      '{resourceMetrics:[{resource:{attributes:[{key:"host.name",value:{stringValue:$host}},{key:"service.name",value:{stringValue:$service}}]},scopeMetrics:[{scope:{name:$service},metrics:$metrics}]}]}')"

    if ! ${pkgs.curl}/bin/curl -fsS -X POST "$otlp_endpoint" \
      -H 'Content-Type: application/json' \
      -d "$payload" >/dev/null; then
      echo "hwmon-metrics-sample: local otlp receiver unavailable, skipping sample" >&2
      exit 0
    fi
  '';
in
{
  options.services.hwmon-metrics.enable =
    lib.mkEnableOption "sysfs hwmon temperature metrics via local OTLP";

  config = lib.mkIf cfg.enable {
    systemd.services.hwmon-metrics-sample = {
      description = "Sample sysfs hwmon temperatures into local OpenTelemetry Collector";
      after = [ "otelcol-axiom.service" ];
      requires = [ "otelcol-axiom.service" ];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = sample;
        User = "bdsqqq";
        Group = "users";
      };
    };

    systemd.timers.hwmon-metrics-sample = {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = "30s";
        OnUnitActiveSec = "30s";
        AccuracySec = "5s";
        Unit = "hwmon-metrics-sample.service";
      };
    };
  };
}

{ pkgs, config, ... }:

let
  sample = pkgs.writeShellScript "legion-metrics-sample" ''
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

    legion=/sys/devices/platform/legion-wmi-fan
    if [[ -r "$legion/fan_curve_percent" ]]; then
      i=1
      for percent in $(cat "$legion/fan_curve_percent"); do
        temp_c=$((i * 10))
        add_gauge "legion.fan.curve.percent" "$percent" "%" \
          "$(${pkgs.jq}/bin/jq -n --arg point "$i" --arg temp "$temp_c" '[{key:"point",value:{intValue:$point}},{key:"temperature.celsius",value:{intValue:$temp}}]')"
        i=$((i + 1))
      done
    fi

    for hwmon in /sys/class/hwmon/hwmon*; do
      [[ -r "$hwmon/name" ]] || continue
      [[ "$(cat "$hwmon/name")" == "legion_wmi_fan" ]] || continue
      if [[ -r "$hwmon/pwm1_enable" ]]; then
        add_gauge "legion.fan.mode" "$(cat "$hwmon/pwm1_enable")" "1" '[]'
      fi
      break
    done

    metrics="$(cat "$tmp")"
    [[ "$metrics" != "[]" ]] || exit 0

    payload="$(${pkgs.jq}/bin/jq -n \
      --arg host "${config.networking.hostName}" \
      --arg service "legion-sysfs-sampler" \
      --argjson metrics "$metrics" \
      '{resourceMetrics:[{resource:{attributes:[{key:"host.name",value:{stringValue:$host}},{key:"service.name",value:{stringValue:$service}}]},scopeMetrics:[{scope:{name:$service},metrics:$metrics}]}]}')"

    if ! ${pkgs.curl}/bin/curl -fsS -X POST "$otlp_endpoint" \
      -H 'Content-Type: application/json' \
      -d "$payload" >/dev/null; then
      echo "legion-metrics-sample: local otlp receiver unavailable, skipping sample" >&2
      exit 0
    fi
  '';
in {
  systemd.services.legion-metrics-sample = {
    description = "Sample Legion sysfs metrics into local OpenTelemetry Collector";
    after = [ "otelcol-axiom.service" ];
    requires = [ "otelcol-axiom.service" ];
    serviceConfig = {
      Type = "oneshot";
      ExecStart = sample;
      User = "bdsqqq";
      Group = "users";
    };
  };

  systemd.timers.legion-metrics-sample = {
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnBootSec = "30s";
      OnUnitActiveSec = "30s";
      AccuracySec = "5s";
      Unit = "legion-metrics-sample.service";
    };
  };
}

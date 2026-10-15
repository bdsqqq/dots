# hue native readiness

`my.openhue.integration` defaults to disabled. enabled mode requires the exact
`bridge` address, private absolute `configHome` (the native XDG_CONFIG_HOME), and
`nativeConfigFile = "${configHome}/openhue/config.yaml"`. the native config contains
the approved bridge key and remains private/mutable. native physical pairing is an
explicit setup action; no activation performs pairing or network access.

`openhue-ready --local` parses the private YAML, matches the configured bridge,
and requires a nonempty key. it does not prove key validity. `openhue-ready` runs
pinned `get --type bridge --json`, with XDG_CONFIG_HOME explicitly selected,
checks a nonempty array of bridge resources with ids, and suppresses private
output/errors. this is a bounded authenticated bridge read, not lighting control.
zero exit status alone is insufficient: v0.24 exits zero for missing configuration.
each process has a 15-second deadline; the upstream get command loads the home
model before the resource read, so this is bounded in time/output, not one HTTP call.
private config mode must be owner-only; native setup permissions may need explicit
correction before readiness. no fake config or SOPS pairing-key snapshot is provided.

sources: [0.24 configuration](https://github.com/openhue/openhue-cli/blob/0.24/openhue/config.go),
[get flags/resources](https://github.com/openhue/openhue-cli/blob/0.24/cmd/get/get.go),
[home loading](https://github.com/openhue/openhue-cli/blob/0.24/cmd/root.go).

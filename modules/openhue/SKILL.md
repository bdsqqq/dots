---
name: openhue
description: "Inspect or control Philips Hue lights, rooms, and scenes through a LAN Hue Bridge using openhue. Use for bridge-backed Hue requests; not Bluetooth-only lights or this repository's custom BLE Hue service."
---

# hue bridge

requires a reachable Philips Hue Bridge and an approved application key.
this is separate from the repository's BLE Hue service: do not reuse its device
addresses, credentials, or service controls. start with `openhue help`; inspect
`openhue get --help` and the chosen resource help before any bridge request.

native config is private: `~/.openhue/config.yaml`, or
`$XDG_CONFIG_HOME/openhue/config.yaml` when that variable is set. it contains the
bridge address and key. upstream writes it through Viper; the module deliberately
does not replace it with a tracked symlink or manufacture an empty config.
do not display the config/key. `setup`, `auth`, and configuration changes can
pair with a physical bridge and persist credentials; run only for explicit setup.

use `openhue get light` / `openhue get room` / `openhue get scene` to resolve
resources from the approved bridge. missing configuration can produce a setup
message with exit status zero in the pinned release: inspect output, not just status.
if there is no bridge, stop; Bluetooth capability is not a substitute.

for a requested light change, inspect `openhue set light --help`, target the exact
returned ID, then use supported flags such as `openhue set light ID --on`.
room-wide or scene actions affect multiple devices: match the user's intended
scope. reread the affected light/room after changing it. report observed bridge
state; that alone does not prove a bulb visibly changed. do not launch MCP,
schedules, or background services as part of a simple lighting request.

sources: [upstream CLI](https://www.openhue.io/cli/openhue-cli),
[pinned private config/write behavior](https://github.com/openhue/openhue-cli/blob/0.24/openhue/config.go).

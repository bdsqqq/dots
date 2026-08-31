#!/bin/sh

TAILSCALE=/mnt/us/extensions/tailscale/bin
SOCKET=/var/run/tailscale/tailscaled.sock
STATE=/mnt/us/tailscale-autostart
EVENTS=$STATE/events.jsonl

mkdir -p "$STATE"

event() {
  printf '{"_time":"%s","host":"kindle","service":"tailscale-autostart","event":"%s","level":"%s"}\n' \
    "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$1" "$2" >>"$EVENTS"
}

if [ ! -x "$TAILSCALE/start_tailscaled_tun.sh" ] || [ ! -x "$TAILSCALE/start_tailscale.sh" ]; then
  event missing_scripts error
  exit 1
fi

if ! pidof tailscaled >/dev/null 2>&1; then
  event starting_daemon info
  if ! "$TAILSCALE/start_tailscaled_tun.sh"; then
    event daemon_start_failed error
    exit 1
  fi
fi

attempts=20
while [ "$attempts" -gt 0 ] && [ ! -S "$SOCKET" ]; do
  sleep 1
  attempts=$((attempts - 1))
done

if [ ! -S "$SOCKET" ]; then
  event socket_timeout error
  exit 1
fi

if timeout 30 "$TAILSCALE/start_tailscale.sh"; then
  if "$TAILSCALE/tailscale" --socket="$SOCKET" set --advertise-tags=tag:ssh-accept; then
    event connected info
    exit 0
  fi

  event tag_configuration_failed error
  exit 1
fi

event connect_failed error
exit 1

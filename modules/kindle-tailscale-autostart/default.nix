{ pkgs }:

pkgs.runCommand "kindle-tailscale-autostart" { } ''
  target="$out/extensions/tailscale-autostart"
  mkdir -p "$target"
  cp -R ${./tailscale-autostart}/. "$target/"
  chmod +x "$target/bin/"*.sh
''

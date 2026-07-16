{ pkgs, ... }:
let
  t3Serve = pkgs.writeShellScript "t3-code-serve" ''
    set -eu

    tailnet_ip="$(${pkgs.tailscale}/bin/tailscale ip -4)"
    exec /home/bdsqqq/.local/share/pnpm/bin/t3 serve \
      --host "$tailnet_ip" \
      --port 3773 \
      --no-browser
  '';
in
{
  networking.firewall.interfaces.tailscale0.allowedTCPPorts = [ 3773 ];

  systemd.services.t3-code = {
    description = "T3 Code server";
    wantedBy = [ "multi-user.target" ];
    wants = [
      "tailscaled.service"
      "home-manager-bdsqqq.service"
    ];
    after = [
      "tailscaled.service"
      "home-manager-bdsqqq.service"
    ];
    restartTriggers = [ ../user/node-pnpm/global-package.json ];

    path = [
      pkgs.coreutils
      pkgs.gnused
      pkgs.nodejs
    ];
    serviceConfig = {
      Type = "exec";
      User = "bdsqqq";
      Group = "users";
      WorkingDirectory = "/home/bdsqqq";
      ExecStart = t3Serve;
      Restart = "always";
      RestartSec = "5s";
    };
  };
}

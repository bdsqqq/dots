{ config, pkgs, ... }:
let
  toolsBin = "${config.my.paths.commonplace}/01_files/nix/user/node-pnpm/node_modules/.bin";
  t3Serve = pkgs.writeShellScript "t3-code-serve" ''
    set -eu

    tailnet_ip="$(${pkgs.tailscale}/bin/tailscale ip -4)"
    exec ${toolsBin}/t3 serve \
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
    wants = [ "tailscaled.service" ];
    requires = [ "home-manager-bdsqqq.service" ];
    after = [
      "tailscaled.service"
      "home-manager-bdsqqq.service"
    ];
    restartTriggers = [
      ../user/node-pnpm/package.json
      ../user/node-pnpm/pnpm-lock.yaml
    ];

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

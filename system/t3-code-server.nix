{ config, hostSystem, lib, pkgs, ... }:
let
  isDarwin = lib.hasSuffix "-darwin" hostSystem;
  isLinux = lib.hasSuffix "-linux" hostSystem;
  toolsDir = "${config.my.paths.commonplace}/01_files/nix/user/node-pnpm";
  toolsBin = "${toolsDir}/node_modules/.bin";
  developmentServer = "${toolsDir}/t3-pi/dist/bin.mjs";
  tailscaleServePort = if isDarwin then 8443 else 443;
  t3Serve = pkgs.writeShellScript "t3-code-serve" ''
    set -eu

    if [ -f ${lib.escapeShellArg developmentServer} ]; then
      t3_command="${pkgs.nodejs}/bin/node ${developmentServer}"
    else
      t3_command="${toolsBin}/t3"
    fi

    exec $t3_command serve \
      --host 127.0.0.1 \
      --port 3773 \
      --tailscale-serve \
      --tailscale-serve-port ${toString tailscaleServePort} \
      --no-browser
  '';
in
if isLinux then
  {
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
        pkgs.git
        pkgs.gnused
        pkgs.nodejs
        pkgs.tailscale
        toolsBin
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
else if isDarwin then
  {
    launchd.user.agents.t3-code = {
      path = [
        pkgs.coreutils
        pkgs.git
        pkgs.nodejs
        "/usr/local/bin"
        toolsBin
      ];
      command = t3Serve;
      serviceConfig = {
        Label = "dev.t3-code.server";
        RunAtLoad = true;
        KeepAlive = true;
        WorkingDirectory = "/Users/bdsqqq";
        StandardOutPath = "/Users/bdsqqq/Library/Logs/t3-code.log";
        StandardErrorPath = "/Users/bdsqqq/Library/Logs/t3-code-error.log";
      };
    };
  }
else
  { }

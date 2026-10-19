{ config, lib, pkgs, hostSystem ? null, ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  isLinux = lib.hasInfix "linux" hostSystem;
  repoRoot = "${config.my.paths.commonplace}/01_files/nix";
  # Darwin's hostName can include .local; the roster uses short SSH host names.
  localHost = if isDarwin then config.networking.localHostName else config.networking.hostName;
  peers = builtins.filter (host: host != localHost) [ "mbp-m2" "lgo-z2e" "htz-xfs-lab" ];
  # The service-host ACL in tailscale/policy.hujson does not grant outbound SSH
  # to owner devices. Owner-initiated exchange is bidirectional; keep this host's
  # roster for inbound authentication without scheduling forbidden connections.
  jobs = {
    pi-memory = "reconcile";
    pi-memory-capture = "catch-up";
  } // lib.optionalAttrs (localHost != "htz-xfs-lab") {
    pi-memory-replicate = "replicate";
  };
  # Bandwidth, not a work deadline: backlog may drain slowly without heating
  # the laptop. Manual one-shot commands remain uncapped.
  backgroundCpuPercent = 5;
  toolsBin = "${repoRoot}/modules/node-pnpm/node_modules/.bin";
  agentMemory = pkgs.writeShellApplication {
    name = "pi-memory";
    runtimeInputs = [ pkgs.coreutils pkgs.git pkgs.nodejs pkgs.python3 pkgs.openssh ];
    text = ''
      set -euo pipefail

      export PI_BIN="${toolsBin}/pi"
      export QMD_BIN="${toolsBin}/qmd"
      # defaults lose to editable native namespace settings and explicit overrides.
      if [[ -z "''${PI_MEMORY_DEFAULT_PEERS+x}" ]]; then
        export PI_MEMORY_DEFAULT_PEERS=${lib.escapeShellArg (builtins.toJSON peers)}
      fi
      export PI_MEMORY_LEGACY_GIT_REMOTE="''${PI_MEMORY_LEGACY_GIT_REMOTE:-git@github.com:bdsqqq/pi-memory.git}"
      # Resolve from the live installation, not the store or the caller's cwd.
      jiti_register="$(cd "${repoRoot}/modules/pi" && node --input-type=module \
        --eval 'console.log(import.meta.resolve("jiti/register"))')"
      # Node resolves module symlinks; keep argv[1] aligned with the CLI main guard.
      source="$(realpath "${repoRoot}/modules/pi/packages/core/agent-memory/index.ts")"
      exec node --import "$jiti_register" "$source" "$@"
    '';
  };
  backgroundMemory = pkgs.writeShellApplication {
    name = "pi-memory-background";
    runtimeInputs = [ pkgs.python3 ];
    text = ''
      exec python3 ${./cpu-budget.py} --percent ${toString backgroundCpuPercent} -- ${agentMemory}/bin/pi-memory watch "$@"
    '';
  };
in
{
  home-manager.users.bdsqqq = { config, ... }: {
    home.packages = [ agentMemory ];

    # Each resident job watches durable inputs and backs off when idle/failing.
    # Supervisors restart crashed watchers; they do not poll the full store.
    launchd.agents = lib.mkIf isDarwin (lib.mapAttrs (name: command: {
      enable = true;
      config = {
        ProgramArguments = [ "${backgroundMemory}/bin/pi-memory-background" command ];
        RunAtLoad = true;
        KeepAlive = true;
        ExitTimeOut = 0;
        ProcessType = "Background";
        ThrottleInterval = 60;
        StandardOutPath = "${config.home.homeDirectory}/Library/Logs/${name}.log";
        StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/${name}.log";
      };
    }) jobs);

    systemd.user.services = lib.mkIf isLinux (lib.mapAttrs (_: command: {
      Unit.Description = "Pi memory ${command}";
      Service = {
        Type = "simple";
        ExecStart = "${agentMemory}/bin/pi-memory watch ${command}";
        Restart = "always";
        RestartSec = "1m";
        CPUAccounting = true;
        CPUQuota = "${toString backgroundCpuPercent}%";
        Nice = 19;
        TimeoutStopSec = "infinity";
        SendSIGKILL = false;
      };
      Install.WantedBy = [ "default.target" ];
    }) jobs);
  };
}

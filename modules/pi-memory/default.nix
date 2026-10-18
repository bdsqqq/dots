{ config, lib, pkgs, hostSystem ? null, ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  isLinux = lib.hasInfix "linux" hostSystem;
  repoRoot = "${config.my.paths.commonplace}/01_files/nix";
  peers = builtins.filter (host: host != config.networking.hostName) [ "mbp-m2" "lgo-z2e" "htz-xfs-lab" ];
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
in
{
  home-manager.users.bdsqqq = { config, ... }: {
    home.packages = [ agentMemory ];

    launchd.agents.pi-memory = lib.mkIf isDarwin {
      enable = true;
      config = {
        ProgramArguments = [ "${agentMemory}/bin/pi-memory" "maintain" ];
        RunAtLoad = true;
        StartInterval = 60;
        ProcessType = "Background";
        ThrottleInterval = 60;
        StandardOutPath = "${config.home.homeDirectory}/Library/Logs/pi-memory.log";
        StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/pi-memory.log";
      };
    };

    systemd.user.services.pi-memory = lib.mkIf isLinux {
      Unit.Description = "Capture native pi sessions, reconcile eligible backlog and replicate memory";
      Service = {
        Type = "oneshot";
        TimeoutStartSec = 180;
        ExecStart = "${agentMemory}/bin/pi-memory maintain";
      };
    };

    systemd.user.timers.pi-memory = lib.mkIf isLinux {
      Unit.Description = "Periodic pi session and agent memory maintenance";
      Timer = {
        OnBootSec = "1m";
        OnUnitActiveSec = "1m";
        Persistent = true;
      };
      Install.WantedBy = [ "timers.target" ];
    };

  };
}

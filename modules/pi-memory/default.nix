{ config, lib, pkgs, hostSystem ? null, ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  isLinux = lib.hasInfix "linux" hostSystem;
  repoRoot = "${config.my.paths.commonplace}/01_files/nix";
  toolsBin = "${repoRoot}/modules/node-pnpm/node_modules/.bin";
  agentMemory = pkgs.writeShellApplication {
    name = "pi-memory";
    runtimeInputs = [ pkgs.bun pkgs.coreutils pkgs.git pkgs.nodejs ];
    text = ''
      set -euo pipefail

      export PI_BIN="${toolsBin}/pi"
      export QMD_BIN="${toolsBin}/qmd"
      export PI_MEMORY_MODEL="openai-codex/gpt-5.6-sol"
      export PI_MEMORY_REASONING_LEVEL="low"
      export PI_MEMORY_CLEANUP_ENABLED=1
      export PI_MEMORY_SKILLS_ROOT="${repoRoot}/modules/agents/skills"
      export PI_MEMORY_GIT_REMOTE="git@github.com:bdsqqq/pi-memory.git"
      exec bun run "${repoRoot}/modules/pi/packages/core/agent-memory/index.ts" "$@"
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
        StartInterval = 3600;
        KeepAlive = {
          PathState = {
            "${config.home.homeDirectory}/.local/state/pi-memory/v3/demand/wake" = true;
          };
        };
        ProcessType = "Background";
        ThrottleInterval = 60;
        StandardOutPath = "${config.home.homeDirectory}/Library/Logs/pi-memory.log";
        StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/pi-memory.log";
      };
    };

    systemd.user.services.pi-memory = lib.mkIf isLinux {
      Unit.Description = "Project pi sessions and maintain agent memory candidates";
      Service = {
        Type = "oneshot";
        ExecStart = "${agentMemory}/bin/pi-memory maintain";
      };
    };

    systemd.user.timers.pi-memory = lib.mkIf isLinux {
      Unit.Description = "Periodic pi session and agent memory maintenance";
      Timer = {
        OnBootSec = "5m";
        OnUnitActiveSec = "1h";
        Persistent = true;
      };
      Install.WantedBy = [ "timers.target" ];
    };

    systemd.user.paths.pi-memory = lib.mkIf isLinux {
      Unit.Description = "Run agent memory maintenance when durable demand arrives";
      Path.PathExists = "${config.home.homeDirectory}/.local/state/pi-memory/v3/demand/wake";
      Install.WantedBy = [ "default.target" ];
    };
  };
}

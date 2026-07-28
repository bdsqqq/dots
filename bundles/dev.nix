{ config, lib, pkgs, hostSystem ? null, headMode ? "graphical", ... }:
let
  isGraphical = headMode == "graphical";
  isDarwin = lib.hasInfix "darwin" hostSystem;
  isLinux = lib.hasInfix "linux" hostSystem;
  repoRoot = "${config.my.paths.commonplace}/01_files/nix";
  toolsBin = "${repoRoot}/user/node-pnpm/node_modules/.bin";
  agentMemory = pkgs.writeShellApplication {
    name = "pi-memory";
    runtimeInputs = [ pkgs.bun pkgs.coreutils pkgs.git pkgs.nodejs ];
    text = ''
      set -euo pipefail

      export PI_BIN="${toolsBin}/pi"
      export QMD_BIN="${toolsBin}/qmd"
      export PI_MEMORY_MODEL="openai-codex/gpt-5.6-sol"
      export PI_MEMORY_REASONING_LEVEL="low"
      export PI_MEMORY_SKILLS_ROOT="${repoRoot}/user/agents/skills"
      export PI_MEMORY_GIT_REMOTE="git@github.com:bdsqqq/pi-memory.git"
      exec bun run "${repoRoot}/user/pi/packages/core/agent-memory/index.ts" "$@"
    '';
  };
in
{
  imports = [
    ../user/nvim
    ../user/git
    ../user/node-pnpm
    ../user/dev-tools.nix
    ../user/trash.nix
    (import ../zmx.nix).module
    ../user/direnv.nix
    ../user/rust.nix
    ../user/go.nix
    ../user/lua.nix
    ../user/typescript.nix
    ../user/nix.nix
    ../user/fairy-name.nix
    ../user/tmux.nix
    ../user/amp.nix
    ../user/pi
    ../user/agents
  ] ++ lib.optionals isGraphical [ ../user/ghostty.nix ];

  home-manager.users.bdsqqq = { config, ... }: {
    home.packages = [ agentMemory ];

    launchd.agents.pi-memory = lib.mkIf isDarwin {
      enable = true;
      config = {
        ProgramArguments = [ "${agentMemory}/bin/pi-memory" "maintain" ];
        RunAtLoad = true;
        StartInterval = 3600;
        ProcessType = "Background";
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
  };
}

{ config, lib, pkgs, hostSystem ? null, headMode ? "graphical", ... }:
let
  isGraphical = headMode == "graphical";
  isDarwin = lib.hasInfix "darwin" hostSystem;
  isLinux = lib.hasInfix "linux" hostSystem;
  repoRoot = "${config.my.paths.commonplace}/01_files/nix";
  toolsBin = "${repoRoot}/user/node-pnpm/node_modules/.bin";
  agentMemory = pkgs.writeShellApplication {
    name = "agent-memory";
    runtimeInputs = [ pkgs.bun pkgs.coreutils pkgs.nodejs ];
    text = ''
      set -euo pipefail

      export PI_BIN="${toolsBin}/pi"
      export QMD_BIN="${toolsBin}/qmd"
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

    launchd.agents.agent-memory = lib.mkIf isDarwin {
      enable = true;
      config = {
        ProgramArguments = [ "${agentMemory}/bin/agent-memory" "maintain" ];
        RunAtLoad = true;
        StartInterval = 900;
        ProcessType = "Background";
        StandardOutPath = "${config.home.homeDirectory}/Library/Logs/agent-memory.log";
        StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/agent-memory.log";
      };
    };

    systemd.user.services.agent-memory = lib.mkIf isLinux {
      Unit.Description = "Project pi sessions and maintain agent memory candidates";
      Service = {
        Type = "oneshot";
        ExecStart = "${agentMemory}/bin/agent-memory maintain";
      };
    };

    systemd.user.timers.agent-memory = lib.mkIf isLinux {
      Unit.Description = "Periodic pi session and agent memory maintenance";
      Timer = {
        OnBootSec = "5m";
        OnUnitActiveSec = "15m";
        Persistent = true;
      };
      Install.WantedBy = [ "timers.target" ];
    };
  };
}

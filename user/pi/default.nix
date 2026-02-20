{ lib, inputs, hostSystem ? null, config ? {}, ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  homeDir = if isDarwin then "/Users/bdsqqq" else "/home/bdsqqq";
in
{
  sops.templates."pi-auth.json" = {
    content = builtins.toJSON {
      openrouter = { type = "api_key"; key = config.sops.placeholder.open_router; };
      opencode = { type = "api_key"; key = config.sops.placeholder.opencode_zen; };
    };
    owner = "bdsqqq";
    mode = "0600";
  };

  home-manager.users.bdsqqq = { pkgs, config, lib, ... }: {
    home.file.".pi/agent/auth.json".source = config.lib.file.mkOutOfStoreSymlink "/run/secrets/rendered/pi-auth.json";
    home.file.".pi/agent/settings.json".source = config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/commonplace/01_files/nix/user/pi/settings.json";

    # subagent extension — directory-based, agents discovered from ~/.pi/agent/agents at runtime
    home.file.".pi/agent/extensions/sub-agents" = {
      source = ./extensions/sub-agents;
      recursive = true;
    };

    # editor extension — box-drawing borders with composable label slots via EventBus
    home.file.".pi/agent/extensions/editor.ts".source = ./extensions/editor.ts;

    # handoff extension — replaces compaction with LLM-driven context transfer
    home.file.".pi/agent/extensions/handoff.ts".source = ./extensions/handoff.ts;

    # session-name extension — auto-generates session titles from first user message
    home.file.".pi/agent/extensions/session-name.ts".source = ./extensions/session-name.ts;

    # tool-harness — gates extension tools via PI_INCLUDE_TOOLS env var
    home.file.".pi/agent/extensions/tool-harness.ts".source = ./extensions/tool-harness.ts;

    # tools extension — custom tool implementations + shared infrastructure (mutex, AGENTS.md, undo tracking)
    home.file.".pi/agent/extensions/tools" = {
      source = ./extensions/tools;
      recursive = true;
    };

    # handoff skill — teaches the agent about context management via handoff
    home.file.".pi/agent/skills/handoff/SKILL.md".source = ./skills/handoff/SKILL.md;

    # agent definitions — point to decrypted prompts in ~/.config/agents/prompts
    home.file.".pi/agent/agents".source = config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/.config/agents/prompts";
  };
}

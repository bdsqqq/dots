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

    # subagent extension - install to ~/.pi/agent/extensions/subagent/
    home.file.".pi/agent/extensions/subagent/index.ts".source = ./extensions/subagent/index.ts;
    home.file.".pi/agent/extensions/subagent/agents.ts".source = ./extensions/subagent/agents.ts;

    # subagent extension - agents (point to existing prompts folder)
    home.file.".pi/agent/agents".source = ../agents/prompts;

    # subagent extension - prompts
    home.file.".pi/agent/prompts".source = ./extensions/subagent/prompts;
  };
}

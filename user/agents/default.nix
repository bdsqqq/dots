{ lib, inputs, hostSystem ? null, config ? {}, ... }:
{
  imports = [
    "./skills/default.nix"
  ];
  home-manager.users.bdsqqq = { pkgs, config, lib, ... }: {
    # home.file + mkOutOfStoreSymlink creates a 3-hop chain through /nix/store/
    # that iOS syncthing can't resolve. home.activation + ln -sf bypasses
    # home-manager's indirection to create a direct symlink.
    # (same pattern as bun.nix:33 for the global manifest)
    home.activation.commonplaceAgents = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      ln -sf "${config.home.homeDirectory}/commonplace/01_files/nix/config/global-agents.md" \
             "${config.home.homeDirectory}/commonplace/AGENTS.md"
    '';

    home.file = let 
      agentsMd = config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/commonplace/01_files/nix/config/global-agents.md";
      skills = config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/.config/agents/skills";

    in {
      ".config/agents/skills" = {
        source = ./skills;
        filter = (path: type: (!(lib.hasSuffix ".nix" path)));
        recursive = true;
      };

      ".config/amp/AGENTS.md".source      = agentsMd;
      ".config/opencode/AGENTS.md".source = agentsMd; 
      ".claude/CLAUDE.md".source          = agentsMd; 
      ".pi/agent/AGENTS.md".source        = agentsMd; 
      ".cursor/rules/AGENTS.md".source    = agentsMd;

      ".config/opencode/skills".source  = skills;
      ".cursor/skills".source           = skills;

      # prompt files are unpacked by sops-unpack-prompts launchd daemon
      # into ~/.config/agents/prompts/ — no home-manager management needed
    };
  };
}

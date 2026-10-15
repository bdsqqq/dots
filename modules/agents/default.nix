{ lib, inputs, hostSystem ? null, config ? { }, ... }: {
  home-manager.users.bdsqqq = { pkgs, config, lib, ... }: {
    # home.file + mkOutOfStoreSymlink creates a 3-hop chain through /nix/store/
    # that iOS syncthing can't resolve. home.activation + ln -sf bypasses
    # home-manager's indirection to create a direct symlink.
    # (same direct-symlink pattern used for repo-owned manifests)
    home.activation.commonplaceAgents =
      lib.hm.dag.entryAfter [ "commonplaceScaffold" ] ''
        ln -sf "01_files/nix/config/global-agents.md" \
               "${config.home.homeDirectory}/commonplace/AGENTS.md"
      '';

    home.file = let
      agentsMd = config.lib.file.mkOutOfStoreSymlink
        "${config.home.homeDirectory}/commonplace/01_files/nix/config/global-agents.md";
      # Programs install skills by writing here; new entries surface as
      # untracked repo files to commit or discard.
      skills = config.lib.file.mkOutOfStoreSymlink
        "${config.home.homeDirectory}/commonplace/01_files/nix/modules/agents/skills";
      bdsPiConfig = config.lib.file.mkOutOfStoreSymlink
        "${config.home.homeDirectory}/commonplace/01_files/nix/modules/agents/bds-pi.json";

    in {
      ".config/agents/skills".source = skills;

      ".claude/CLAUDE.md".source = agentsMd;
      ".pi/agent/AGENTS.md".source = agentsMd;
      ".pi/agent/bds-pi.json".source = bdsPiConfig;
      ".codex/AGENTS.md" = {
        source = agentsMd;
        force = true;
      };

      ".agents/skills".source = skills;
      ".claude/skills".source = skills;
    };
  };
}

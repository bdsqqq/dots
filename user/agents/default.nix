{ lib, inputs, hostSystem ? null, config ? { }, ... }: {
  imports = [ ./skills/default.nix ];
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
      skills = config.lib.file.mkOutOfStoreSymlink
        "${config.home.homeDirectory}/.config/agents/skills";
      agentPrompts = config.lib.file.mkOutOfStoreSymlink
        "${config.home.homeDirectory}/commonplace/01_files/nix/user/agents/agents";

    in {
      ".config/agents/skills" = {
        source = (builtins.path {
          path = ./skills;
          filter = (path: type: (!(lib.hasSuffix ".nix" path)));
        });
        recursive = true;
      };

      ".claude/CLAUDE.md".source = agentsMd;
      ".pi/agent/AGENTS.md".source = agentsMd;
      ".cursor/rules/AGENTS.md".source = agentsMd;
      ".codex/AGENTS.md" = {
        source = agentsMd;
        force = true;
      };

      ".agents/skills".source = skills;
      ".cursor/skills".source = skills;
      ".cursor/agents".source = agentPrompts;
    };
  };
}

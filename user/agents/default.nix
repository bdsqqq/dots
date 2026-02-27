{ lib, inputs, hostSystem ? null, config ? {}, ... }:
{
  home-manager.users.bdsqqq = { pkgs, config, lib, ... }: {
    # home.file + mkOutOfStoreSymlink creates a 3-hop chain through /nix/store/
    # that iOS syncthing can't resolve. home.activation + ln -sf bypasses
    # home-manager's indirection to create a direct symlink.
    # (same pattern as bun.nix:33 for the global manifest)
    home.activation.commonplaceAgents = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      ln -sf "${config.home.homeDirectory}/commonplace/01_files/nix/config/global-agents.md" \
             "${config.home.homeDirectory}/commonplace/AGENTS.md"
    '';

    home.file = {
      # global AGENTS.md symlinks (outside sync folder — symlinks fine)
      ".config/amp/AGENTS.md".source = config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/commonplace/01_files/nix/config/global-agents.md";
      ".config/opencode/AGENTS.md".source = config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/commonplace/01_files/nix/config/global-agents.md";
      ".claude/CLAUDE.md".source = config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/commonplace/01_files/nix/config/global-agents.md";
      ".pi/agent/AGENTS.md".source = config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/commonplace/01_files/nix/config/global-agents.md";

      # shared skills directory — tool-agnostic location
      ".config/agents/skills" = {
        source = ./skills;
        recursive = true;
      };

      # symlink each tool's skills path to the shared location
      ".config/opencode/skills".source = config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/.config/agents/skills";

      ".config/agents/skills/axiom" = {
        source = "${inputs.axiom-skills}/skills";
        recursive = true;
      };
      
      ".config/agents/skills/lnr/SKILL.md" = {
        source = "${inputs.lnr}/SKILL.md";
      };

      ".config/agents/skills/ralph" = {
        source = "${inputs.snarktank-ralph-skills}/skills";
        recursive = true;
      };

      ".config/agents/skills/react-best-practices" = {
        source = "${inputs.vercel-skills}/skills/react-best-practices";
        recursive = true;
      };

      ".config/agents/skills/web-design-guidelines" = {
        source = "${inputs.vercel-skills}/skills/web-design-guidelines";
        recursive = true;
      };

      ".config/agents/skills/agent-browser" = {
        source = "${inputs.agent-browser}/skills/agent-browser";
        recursive = true;
      };

      # prompt files are unpacked by sops-unpack-prompts launchd daemon
      # into ~/.config/agents/prompts/ — no home-manager management needed
    };
  };
}

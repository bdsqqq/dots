{ lib, inputs, hostSystem ? null, config ? {}, ... }:
{
  home-manager.users.bdsqqq = { pkgs, config, lib, ... }: {
    # global AGENTS.md symlinks (config/global-agents.md → every tool that reads it)
    home.file."commonplace/AGENTS.md".source = config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/commonplace/01_files/nix/config/global-agents.md";
    home.file.".config/amp/AGENTS.md".source = config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/commonplace/01_files/nix/config/global-agents.md";
    home.file.".config/opencode/AGENTS.md".source = config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/commonplace/01_files/nix/config/global-agents.md";
    home.file.".claude/CLAUDE.md".source = config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/commonplace/01_files/nix/config/global-agents.md";

    # shared skills directory — tool-agnostic location
    home.file.".config/agents/skills" = {
      source = ./skills;
      recursive = true;
    };

    # symlink each tool's skills path to the shared location
    home.file.".config/opencode/skills".source = config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/.config/agents/skills";

    home.file.".config/agents/skills/axiom" = {
      source = "${inputs.axiom-skills}/skills";
      recursive = true;
    };
    
    home.file.".config/agents/skills/lnr/SKILL.md" = {
      source = "${inputs.lnr}/SKILL.md";
    };

    home.file.".config/agents/skills/ralph" = {
      source = "${inputs.snarktank-ralph-skills}/skills";
      recursive = true;
    };

    home.file.".config/agents/skills/react-best-practices" = {
      source = "${inputs.vercel-skills}/skills/react-best-practices";
      recursive = true;
    };

    home.file.".config/agents/skills/web-design-guidelines" = {
      source = "${inputs.vercel-skills}/skills/web-design-guidelines";
      recursive = true;
    };

    home.file.".config/agents/skills/agent-browser" = {
      source = "${inputs.agent-browser}/skills/agent-browser";
      recursive = true;
    };
  };
}

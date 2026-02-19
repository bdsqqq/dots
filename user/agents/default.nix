{ lib, inputs, hostSystem ? null, config ? {}, ... }:
let
  promptEntries = builtins.readDir ./prompts;
  promptNames = map (n: lib.removeSuffix ".md" n)
    (builtins.attrNames (lib.filterAttrs (n: t: t == "regular" && lib.hasSuffix ".md" n) promptEntries));
in
{
  home-manager.users.bdsqqq = { pkgs, config, lib, ... }: {
    home.file = {
      # global AGENTS.md symlinks (config/global-agents.md → every tool that reads it)
      "commonplace/AGENTS.md".source = config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/commonplace/01_files/nix/config/global-agents.md";
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

      # decrypted prompt files — sops secrets symlinked from /run/secrets/
    } // builtins.listToAttrs (map (name: {
      name = ".config/agents/prompts/${name}.md";
      value.source = config.lib.file.mkOutOfStoreSymlink "/run/secrets/prompt-${name}";
    }) promptNames);
  };
}

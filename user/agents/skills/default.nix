{ lib, inputs, hostSystem ? null, config ? {}, ... }:
{
  home-manager.users.bdsqqq = { pkgs, config, lib, ... }: {
    home.file = {
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
    };
  };
}

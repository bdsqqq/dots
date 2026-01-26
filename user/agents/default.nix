{ lib, inputs, hostSystem ? null, config ? {}, ... }:
{
  home-manager.users.bdsqqq = { pkgs, config, lib, ... }: {
    home.file."AGENTS.md" = {
      source = config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/commonplace/AGENTS.md";
    };

    home.file.".config/agents/skills" = {
      source = ./skills;
      recursive = true;
    };

    home.file.".config/agents/skills/axiom-sre" = {
      source = "${inputs.axiom-skills}/skills/sre";
      recursive = true;
    };
    
    home.file.".config/agents/skills/lnr/SKILL.md" = {
      source = "${inputs.lnr}/SKILL.md";
    };

    home.file.".config/agents/skills/compound-engineering" = {
      source = "${inputs.snarktank-skills}/compound-engineering";
      recursive = true;
    };
    home.file.".config/agents/skills/frontend-design" = {
      source = "${inputs.snarktank-skills}/frontend-design";
      recursive = true;
    };
    home.file.".config/agents/skills/prd" = {
      source = "${inputs.snarktank-skills}/prd";
      recursive = true;
    };
    home.file.".config/agents/skills/ralph" = {
      source = "${inputs.snarktank-skills}/ralph";
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
  };
}

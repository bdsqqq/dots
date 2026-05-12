{ lib, inputs, hostSystem ? null, config ? { }, ... }: {
  home-manager.users.bdsqqq = { pkgs, config, lib, ... }: {
    home.file = {
      ".config/agents/skills/linear/SKILL.md" = {
        source = "${inputs.lnr}/SKILL.md";
      };

      ".config/agents/skills/hunk-review" = {
        source = "${inputs.hunk}/skills/hunk-review";
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
    };
  };
}

# Keep Nix-specific installation outside ./skills: that directory is the
# authoritative, portable skill collection in dots and is projected as a clean
# Git subtree into Amp's User Skills repository for use in remote agents.
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

      ".config/agents/skills/vercel-react-best-practices" = {
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

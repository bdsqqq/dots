{ lib, inputs, hostSystem ? null, config ? { }, ... }: {
  imports = [ ./skills.nix ];
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

    # ln -sf can preserve old entry casing on Darwin even when its target is
    # SKILL.md. Native discovery compares directory entries, not path equivalence.
    home.activation.normalizeDataVisualizationSkillCase = lib.mkIf pkgs.stdenv.isDarwin
      (lib.hm.dag.entryAfter [ "linkGeneration" ] ''
        normalizeDataVisualizationSkillCase() (
          dir="$HOME/.config/agents/skills/data-visualization"
          [[ -d "$dir" && ! -L "$dir" ]] || exit 0
          lower=
          for entry in "$dir"/*; do
            case "$entry" in
              "$dir/SKILL.md") exit 0 ;;
              "$dir/skill.md") lower="$entry" ;;
            esac
          done
          [[ -n "$lower" && -L "$lower" ]] || exit 0
          expected="$(readlink -e "$newGenPath/home-files")/.config/agents/skills/data-visualization/SKILL.md"
          [[ "$(readlink "$lower")" == "$expected" ]] || exit 0
          temporary="$dir/.SKILL.md.home-manager-case"
          mv -T --update=none-fail -- "$lower" "$temporary" || exit 1
          if ! mv -T --update=none-fail -- "$temporary" "$dir/SKILL.md"; then
            mv -T --update=none-fail -- "$temporary" "$lower" ||
              errorEcho "restore preserved symlink at $temporary manually" >&2
            exit 1
          fi
        )
        run normalizeDataVisualizationSkillCase
        unset -f normalizeDataVisualizationSkillCase
      '');

    home.file = let
      agentsMd = config.lib.file.mkOutOfStoreSymlink
        "${config.home.homeDirectory}/commonplace/01_files/nix/config/global-agents.md";
      skills = config.lib.file.mkOutOfStoreSymlink
        "${config.home.homeDirectory}/.config/agents/skills";
      agentPrompts = config.lib.file.mkOutOfStoreSymlink
        "${config.home.homeDirectory}/commonplace/01_files/nix/modules/agents/agents";
      bdsPiConfig = config.lib.file.mkOutOfStoreSymlink
        "${config.home.homeDirectory}/commonplace/01_files/nix/modules/agents/bds-pi.json";

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
      ".pi/agent/bds-pi.json".source = bdsPiConfig;
      ".cursor/rules/AGENTS.md".source = agentsMd;
      ".codex/AGENTS.md" = {
        source = agentsMd;
        force = true;
      };

      ".agents/skills".source = skills;
      ".cursor/skills".source = skills;
      ".cursor/agents" = {
        source = agentPrompts;
        recursive = true;
      };
    };
  };
}

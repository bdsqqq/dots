{ lib, inputs, hostSystem ? null, ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
in
{
  home-manager.users.bdsqqq = { pkgs, config, ... }: {
    # link the entire skills directory - structure mirrors target
    home.file.".config/amp/skills" = {
      source = ./skills;
      recursive = true;
    };
    
    # external git-based skills (from flake inputs)
    home.file.".config/amp/skills/axiom-sre" = {
      source = inputs.axiom-sre;
      recursive = true;
    };
    
    # lnr skill - just the SKILL.md from the lnr repo
    home.file.".config/amp/skills/lnr/SKILL.md" = {
      source = "${inputs.lnr}/SKILL.md";
    };

    # shell wrappers for rush mode execution
    home.shellAliases = {
      # ship: commit and push in rush mode, continuing current thread
      ship = "amp --mode rush -x 'use the git-ship skill'";
      
      # wt: create worktree in rush mode  
      wt = "amp --mode rush -x 'use the git-worktree skill'";
    };

    # amp wrapper: private by default, but workspace-scoped in axiom repos
    programs.zsh.initExtra = ''
      amp() {
        if [[ "$PWD" = "$HOME/www/axiom"* ]]; then
          command amp "$@"
        else
          command amp --visibility private "$@"
        fi
      }
    '';
  };
}

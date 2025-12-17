{ lib, hostSystem ? null, ... }:
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

    # shell wrappers for rush mode execution
    home.shellAliases = {
      # ship: commit and push in rush mode, continuing current thread
      ship = "amp --mode rush -x 'use the git-ship skill'";
      
      # wt: create worktree in rush mode  
      wt = "amp --mode rush -x 'use the git-worktree skill'";
    };
  };
}

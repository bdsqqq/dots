{ ... }:
let
  git-hunks = { pkgs }: pkgs.stdenv.mkDerivation {
    pname = "git-hunks";
    version = "0.1.0";
    src = pkgs.fetchFromGitHub {
      owner = "rockorager";
      repo = "git-hunks";
      rev = "810609b492daae31fd974c220d77c76780db4b11";
      hash = "sha256-VRscBmZ0Q/vL4B+8mkmQGV4Ppoj1qPpDz0kPAACjV94=";
    };
    nativeBuildInputs = [ pkgs.installShellFiles ];
    dontBuild = true;
    installPhase = ''
      runHook preInstall
      install -Dm755 git-hunks $out/bin/git-hunks
      installManPage git-hunks.1
      runHook postInstall
    '';
  };
in
{
  home-manager.users.bdsqqq = { pkgs, ... }: {
    programs.git = {
      enable = true;
      
      lfs.enable = true;
      
      settings = {
        user = {
          name = "Igor Bedesqui";
          email = "igorbedesqui@gmail.com";
        };
        
        init.defaultBranch = "main";
        
        pull.rebase = true;
        rebase.autoStash = true;
        
        core.pager = "${pkgs.delta}/bin/delta";
        interactive.diffFilter = "${pkgs.delta}/bin/delta --color-only";
        delta = {
          navigate = true;
          side-by-side = true;
        };
        merge.conflictstyle = "diff3";
        diff.colorMoved = "default";
      };
    };
    
    home.packages = with pkgs; [
      lazygit
      delta
      gh
      git-filter-repo
      (git-hunks { inherit pkgs; })
    ];
    
    home.shellAliases = {
      g = "lazygit";
    };
    
    programs.zsh.initContent = ''
      # git worktree helper for bare repo workflow
      wt() {
        local git_dir="."
        if [[ -d "./bare-repo.git" ]]; then
          git_dir="./bare-repo.git"
        else
          echo "⚠ No bare-repo.git found, using current dir"
        fi

        if [[ "$1" == "pr" ]]; then
          local pr_num="$2"
          if [[ -z "$pr_num" ]]; then
            echo "usage: wt pr <number>"
            return 1
          fi
          local branch=$(gh pr view "$pr_num" --json headRefName -q .headRefName)
          if [[ -z "$branch" ]]; then
            echo "failed to get branch for PR #$pr_num"
            return 1
          fi
          git -C "$git_dir" fetch origin "$branch"
          git -C "$git_dir" worktree add "../pr-$pr_num" "origin/$branch"
          echo "created worktree for PR #$pr_num at ../pr-$pr_num (branch: $branch)"
        else
          git -C "$git_dir" worktree add "../$1" -b "$1" origin/main
        fi
      }
    '';
  };
}

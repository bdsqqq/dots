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
    

    
    programs.zsh.initContent = ''
      # initialize bare repo workflow from a remote
      wt-init() {
        local repo="$1"
        [[ -z "$repo" ]] && echo "usage: wt-init <repo-url>" && return 1
        
        git clone --bare "$repo" bare-repo.git
        git -C bare-repo.git config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
        git -C bare-repo.git fetch origin
        git -C bare-repo.git worktree add ../main main
        
        echo "done. bare repo at ./bare-repo.git, main worktree at ./main"
      }

      # lazygit with bare-repo detection
      g() {
        if [[ -d "./bare-repo.git" ]]; then
          if [[ -d "./main" ]]; then
            lazygit -g ./bare-repo.git -w ./main "$@"
          else
            local first_wt=$(find . -maxdepth 1 -type d ! -name '.' ! -name 'bare-repo.git' | head -1)
            if [[ -n "$first_wt" ]]; then
              lazygit -g ./bare-repo.git -w "$first_wt" "$@"
            else
              echo "no worktree found. create one with: wt <name>"
              return 1
            fi
          fi
        else
          lazygit "$@"
        fi
      }

      # worktree status with merge detection and clickable links
      wts() {
        local git_dir="./bare-repo.git"
        [[ ! -d "$git_dir" ]] && echo "no bare-repo.git" && return 1
        
        git -C "$git_dir" fetch origin main --quiet 2>/dev/null || true
        local repo=$(git -C "$git_dir" remote get-url origin 2>/dev/null | sed 's/.*github.com[:/]\(.*\)\.git/\1/')
        
        git -C "$git_dir" worktree list --porcelain | grep "^worktree " | cut -d' ' -f2 | while read wt; do
          [[ "$wt" == *"bare-repo.git" ]] && continue
          local name=$(basename "$wt")
          local head=$(git -C "$wt" rev-parse HEAD 2>/dev/null)
          
          local merged="○"
          if [[ -n "$head" ]] && git -C "$git_dir" merge-base --is-ancestor "$head" origin/main 2>/dev/null; then
            merged="✓"
          fi
          
          local pr_num=$(echo "$name" | grep -oE '^pr-[0-9]+$' | cut -d'-' -f2)
          if [[ -n "$pr_num" ]]; then
            local url="https://github.com/$repo/pull/$pr_num"
            printf '%s \e]8;;%s\e\\%s\e]8;;\e\\\n' "$merged" "$url" "$name"
            continue
          fi
          
          local issue_id=$(echo "$name" | grep -oE '^[a-zA-Z]+-[0-9]+' | tr '[:lower:]' '[:upper:]')
          if [[ -n "$issue_id" ]]; then
            local json=$(lnr issue "$issue_id" --json 2>/dev/null)
            if [[ -n "$json" ]]; then
              local state=$(echo "$json" | jq -r '.state // empty')
              local url=$(echo "$json" | jq -r '.url // empty')
              printf '%s \e]8;;%s\e\\%s\e]8;;\e\\ (%s)\n' "$merged" "$url" "$name" "$state"
              continue
            fi
          fi
          
          echo "$merged $name"
        done
      }

      # git worktree helper for bare repo workflow
      # naming: pr-{number} for reviews, axm-{number}/ai-{number} for own work (Linear issue ID)
      wt() {
        local git_dir="."
        if [[ -d "./bare-repo.git" ]]; then
          git_dir="./bare-repo.git"
        else
          echo "⚠ No bare-repo.git found, using current dir"
        fi

        # handle 'wt pr-6857' as alias for 'wt pr 6857'
        if [[ "$1" =~ ^pr-([0-9]+)$ ]]; then
          set -- "pr" "''${BASH_REMATCH[1]}"
        fi

        if [[ "$1" == "pr" ]]; then
          local pr_num="$2"
          if [[ -z "$pr_num" ]]; then
            echo "usage: wt pr <number>"
            return 1
          fi
          local branch=$(GIT_DIR="$git_dir" gh pr view "$pr_num" --json headRefName -q .headRefName)
          if [[ -z "$branch" ]]; then
            echo "failed to get branch for PR #$pr_num"
            return 1
          fi
          git -C "$git_dir" fetch origin "$branch"
          if git -C "$git_dir" show-ref --verify --quiet "refs/heads/$branch"; then
            git -C "$git_dir" worktree add "../pr-$pr_num" "$branch"
          else
            git -C "$git_dir" worktree add --track -b "$branch" "../pr-$pr_num" "origin/$branch"
          fi
          echo "created worktree for PR #$pr_num at ../pr-$pr_num (branch: $branch)"
        else
          local name="''${(L)1}"
          git -C "$git_dir" worktree add "../$name" -b "$name" origin/main
        fi
      }
    '';
  };
}

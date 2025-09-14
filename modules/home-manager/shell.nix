{ config, pkgs, lib, ... }:

{
  # Ensure home directory structure exists (without overriding existing content)
  home.file = {
    "commonplace/00_inbox/.keep".text = "";
    "commonplace/01_files/.keep".text = "";
    "commonplace/02_temp/.keep".text = "";
    
    # Global ripgrep ignore patterns for fzf integration
    ".rgignore".text = ''
      # Version control systems
      **/.git/
      **/.github/
      **/.svn/
      **/.hg/
      **/.gitmodules
      
      # Package managers and dependencies  
      **/node_modules/
      **/.pnpm/
      **/.pnpm-store/
      **/.yarn/
      **/.npm/
      **/bun/
      **/.bun/
      **/go/pkg/
      **/go/bin/
      **/.cargo/
      **/target/
      **/.stack/
      **/.gradle/
      
      # Build outputs and caches
      **/dist/
      **/build/
      **/out/
      **/coverage/
      **/.next/
      **/.nuxt/
      **/.astro/
      **/.vite/
      **/.parcel-cache/
      **/.cache/
      **/cache/
      **/.turbo/
      **/.vercel/
      **/.netlify/
      **/.million/
      **/generated/
      
      # Development tools and editors
      **/.vscode/
      **/.idea/
      **/.changeset/
      **/.storybook/
      **/.svelte-kit/
      **/.pytest_cache/
      **/.mypy_cache/
      **/.tox/
      **/.venv/
      **/.direnv/
      **/.expo/
      **/.angular/
      
      # OS-specific files
      **/.DS_Store
      **/Thumbs.db
      **/desktop.ini
      **/.Spotlight-V100/
      **/.Trashes/
      **/.fseventsd/
      
      # Temporary and log files
      **/tmp/
      **/temp/
      **/*.tmp
      **/*.temp
      **/*.log
      *.log
      **/*.swp
      **/*.swo
      **/*~
      
      # Build artifacts and binaries
      **/*.o
      **/*.obj
      **/*.exe
      **/*.dll
      **/*.so
      **/*.dylib
      **/*.a
      **/*.woff
      **/*.woff2
      **/*.otf
      **/*.ttf
      **/*.eot
      
      # Minified files and source maps
      **/*.min.js
      **/*.min.css
      **/*.map
      
      # Lock files
      **/package-lock.json
      **/yarn.lock
      **/pnpm-lock.yaml
      **/Cargo.lock
      **/go.sum
      **/*.lock
      
      # Binary/media files (performance)
      **/*.vst
      **/*.vst3
      **/*.component
      **/*.mcmeta
      
      # Syncthing and backup files
      **/.stfolder/
      **/.stversions/
      **/.stignore
      **/rclone_*.log
      **/rclone_*.txt
      
      # Obsidian vault internals
      **/.obsidian/
      
      # Nix build artifacts
      **/result/
      **/result-*
      
      # Project-specific patterns (from your commonplace setup)
      pack-toolbox/temp/
      */assets/minecraft/textures/
    '';
  };

  programs = {
    zsh = {
      enable = true;
      oh-my-zsh = {
        enable = true;
        theme = "vercel";
        plugins = [ "git" ];
        custom = "$HOME/.config/zsh/oh-my-zsh-custom";
      };
      plugins = [
        {
          name = "zsh-autosuggestions";
          src = pkgs.fetchFromGitHub {
            owner = "zsh-users";
            repo = "zsh-autosuggestions";
            rev = "v0.7.0";
            sha256 = "1g3pij5qn2j7v7jjac2a63lxd97mcsgw6xq6k5p7835q9fjiid98";
          };
        }
      ];
      initExtra = ''
        # Show hidden files by default in shell globbing
        setopt GLOB_DOTS
        
        # Configure fzf to use ripgrep with our ignore file
        export FZF_DEFAULT_COMMAND='rg --files --hidden --follow'
        export FZF_CTRL_T_COMMAND="$FZF_DEFAULT_COMMAND"
        export FZF_DEFAULT_OPTS='--height=40% --layout=reverse --border'
      '';
      shellAliases = {
        # Add your custom aliases here
      };
    };

    fzf = {
      enable = true;
      enableZshIntegration = true;
    };

    zoxide = {
      enable = true;
      enableZshIntegration = true;
      options = [
        "--cmd cd"  # Replace cd with zoxide's z command
      ];
    };
  };

  # Custom files
  home.file.".config/zsh/oh-my-zsh-custom/themes/vercel.zsh-theme".text = ''
    local resetColor="%{$reset_color%}"
    local logo="%{$fg_bold[white]%}△$resetColor$resetColor"
    local hostname=`hostname`
    local dir="%{$fg_bold[white]%}%c$resetColor$resetColor"
    local inputIndicator=" %{$fg_bold[White]%}↳ $resetColor"

    GIT_PROMPT_PREFIX="[%{$fg_bold[white]%}"
    GIT_PROMPT_SUFFIX="$resetColor]"
    GIT_PROMPT_DIRTY="%{$fg_bold[lightWhite]%}"
    GIT_PROMPT_CLEAN="%{$fg_bold[darkWhite]%}"

    # modified from https://github.com/robbyrussell/oh-my-zsh/blob/576ada138fc5eed3f58a4aff8141e483310c90fb/lib/git.zsh#L12
    function branch_is_dirty() {
      local STATUS=""
      local -a FLAGS
      FLAGS=('--porcelain')
      if [[ "$(command git config --get oh-my-zsh.hide-dirty)" != "1" ]]; then
        if [[ $POST_1_7_2_GIT -gt 0 ]]; then
          FLAGS+='--ignore-submodules=dirty'
        fi
        if [[ "$DISABLE_UNTRACKED_FILES_DIRTY" == "true" ]]; then
          FLAGS+='--untracked-files=no'
        fi
        STATUS=$(command git status ''${FLAGS} 2> /dev/null | tail -n1)
      fi
      if [[ -n $STATUS ]]; then
        return 0
      else
        return 1
      fi
    }

    function git_prompt() {
      branch=`git_current_branch`
      if [ "$branch" = "" ]; then
        # not a git repo
        echo ""
      else
        if branch_is_dirty; then
          echo "$GIT_PROMPT_PREFIX$GIT_PROMPT_DIRTY$branch$GIT_PROMPT_SUFFIX"
        else
          echo "$GIT_PROMPT_PREFIX$GIT_PROMPT_CLEAN$branch$GIT_PROMPT_SUFFIX"
        fi
      fi
    }
    NEWLINE=$'\n '

    PROMPT='$logo $dir $(git_prompt) $NEWLINE $inputIndicator'
  '';
}

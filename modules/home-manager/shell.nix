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
      # oh-my-zsh = {
      #   enable = true;
      #   theme = "vercel";
      #   plugins = [ "git" ];
      #   custom = "$HOME/.config/zsh/oh-my-zsh-custom";
      # };
      # plugins = [
      #   {
      #     name = "zsh-autosuggestions";
      #     src = pkgs.fetchFromGitHub {
      #       owner = "zsh-users";
      #       repo = "zsh-autosuggestions";
      #       rev = "v0.7.0";
      #       sha256 = "1g3pij5qn2j7v7jjac2a63lxd97mcsgw6xq6k5p7835q9fjiid98";
      #     };
      #   }
      # ];
      initExtra = ''
        # Lazy load completions (major performance win)
        autoload -Uz compinit
        () {
          if [[ $# -gt 0 ]]; then
            compinit -C
          else
            compinit -C -d "$HOME/.zcompdump-''${HOST}-''${ZSH_VERSION}"
          fi
        } ''${ZDOTDIR:-$HOME}/.zcompdump(N.mh+24)
        
        # Show hidden files by default in shell globbing
        setopt GLOB_DOTS
        
        # Configure fzf to use ripgrep with our ignore file
        export FZF_DEFAULT_COMMAND='rg --files --hidden --follow'
        export FZF_CTRL_T_COMMAND="$FZF_DEFAULT_COMMAND"
        export FZF_DEFAULT_OPTS='--height=40% --layout=reverse --border'
        
        # Simple fast prompt (inspired by vercel theme)
        autoload -U colors && colors
        setopt PROMPT_SUBST
        
        # Git branch function (much faster than oh-my-zsh version)
        git_branch() {
          git symbolic-ref --short HEAD 2>/dev/null | sed 's/^/[/' | sed 's/$/]/'
        }
        
        PROMPT='%{$fg_bold[white]%}△ %c%{$reset_color%}$(git_branch)
 %{$fg_bold[white]%}↳ %{$reset_color%}'
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

}

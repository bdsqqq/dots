{ config, pkgs, lib, ... }:

let
  pnpmHomeRelative = if pkgs.stdenv.isDarwin then "/Library/pnpm" else "/.local/share/pnpm";
  pnpmHomeAbsolute = "${config.home.homeDirectory}${pnpmHomeRelative}";
  pnpmManifestFile = ../pnpm-global-package.json;
  pnpmManifestPath = "${config.home.homeDirectory}/commonplace/01_files/nix/pnpm-global-package.json";
  pnpmLockPath = "${config.home.homeDirectory}/commonplace/01_files/nix/pnpm-global-lock.yaml";
  pnpmGlobalRoot = "${pnpmHomeAbsolute}/global";
  pnpmGlobalDir = "${pnpmGlobalRoot}/5";
in
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

  home.activation.installPnpmGlobals = lib.hm.dag.entryAfter ["writeBoundary"] ''
    echo "linking pnpm globals file ${pnpmManifestPath} to ${pnpmGlobalDir}/package.json"
    set -euo pipefail

    PNPM_HOME="${pnpmHomeAbsolute}"
    export PNPM_HOME
    export PATH="$PNPM_HOME:$PATH"

    MANIFEST="${pnpmManifestPath}"
    LOCKFILE="${pnpmLockPath}"
    GLOBAL_ROOT="${pnpmGlobalRoot}"
    GLOBAL_DIR="${pnpmGlobalDir}"

    if [ ! -f "$MANIFEST" ]; then
      echo "pnpm global manifest not found: $MANIFEST" >&2
      exit 0
    fi

    mkdir -p "$GLOBAL_DIR"

    ln -sf "$MANIFEST" "$GLOBAL_DIR/package.json"
    if [ -f "$LOCKFILE" ]; then
      ln -sf "$LOCKFILE" "$GLOBAL_DIR/pnpm-lock.yaml"
    fi

    ln -sfn "$GLOBAL_DIR" "$PNPM_HOME/5"
  '';

  programs.zsh.sessionVariables.PNPM_HOME = "${pnpmHomeAbsolute}";

  home.sessionPath = lib.mkBefore [ "${pnpmHomeAbsolute}" ];

  programs = {
    zsh = {
      enable = true;
      initContent = ''
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
        
        git_branch() {
          local b dirty=""
          b=$(git symbolic-ref --short HEAD 2>/dev/null) || b=$(git rev-parse --short HEAD 2>/dev/null) || return
          if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
            dirty="$fg[white]*%f"
          fi
          print -r -- "[$b]$dirty"
        }
        
        PROMPT='%{$fg_bold[white]%}⁂ %c%{$reset_color%}$(git_branch)
 %{$fg[white]%}└ %{$reset_color%}'
      '';
      shellAliases = {
        l = "ls -lah";
        ll = "ls -l";
        cd = "z";
        c = "clear";
      };
    };

    fzf = {
      enable = true;
      enableZshIntegration = true;
    };

    zoxide = {
      enable = true;
      enableZshIntegration = true;
    }; 
  };
}

{ lib, hostSystem ? null, config, ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  # homebrew prefix varies by architecture
  brewPrefix = if isDarwin then config.homebrew.brewPrefix or "/opt/homebrew" else "";
in
{
  home-manager.users.bdsqqq = { config, pkgs, ... }: {
    xdg.enable = true;
    xdg.userDirs = if isDarwin then {} else {
      enable = true;
      createDirectories = true;
      download = "${config.home.homeDirectory}/commonplace/00_inbox";
      documents = "${config.home.homeDirectory}/commonplace/00_inbox";
      pictures = "${config.home.homeDirectory}/commonplace/00_inbox";
      music = "${config.home.homeDirectory}/commonplace/00_inbox";
      videos = "${config.home.homeDirectory}/commonplace/00_inbox";
      desktop = "${config.home.homeDirectory}/Desktop";
      templates = "${config.home.homeDirectory}/Templates";
      publicShare = "${config.home.homeDirectory}/Public";
    };

    home.sessionVariables = {
      EDITOR = "${pkgs.neovim}/bin/nvim";
      VISUAL = "${pkgs.neovim}/bin/nvim";
    };

    # directory scaffolding and global ripgrep ignore
    home.file = {
      "commonplace/00_inbox/.keep".text = "";
      "commonplace/01_files/.keep".text = "";
      "commonplace/02_temp/.keep".text = "";

      # ai coding agent configurations (symlinked from nix config)
      "commonplace/AGENTS.md".source = config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/commonplace/01_files/nix/AGENTS.md";
      ".config/amp/AGENTS.md".source = config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/commonplace/01_files/nix/AGENTS.md";
      ".claude/CLAUDE.md".source = config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/commonplace/01_files/nix/AGENTS.md";

      ".rgignore".text = ''
        # version control systems
        **/.git/
        **/.github/
        **/.svn/
        **/.hg/
        **/.gitmodules

        # package managers and dependencies
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

        # build outputs and caches
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

        # development tools and editors
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

        # os-specific files
        **/.DS_Store
        **/Thumbs.db
        **/desktop.ini
        **/.Spotlight-V100/
        **/.Trashes/
        **/.fseventsd/

        # temporary and log files
        **/tmp/
        **/temp/
        **/*.tmp
        **/*.temp
        **/*.log
        *.log
        **/*.swp
        **/*.swo
        **/*~

        # build artifacts and binaries
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

        # minified files and source maps
        **/*.min.js
        **/*.min.css
        **/*.map

        # lock files
        **/package-lock.json
        **/yarn.lock
        **/pnpm-lock.yaml
        **/Cargo.lock
        **/go.sum
        **/*.lock

        # binary/media files (performance)
        **/*.vst
        **/*.vst3
        **/*.component
        **/*.mcmeta

        # syncthing and backup files
        **/.stfolder/
        **/.stversions/
        **/.stignore
        **/rclone_*.log
        **/rclone_*.txt

        # obsidian vault internals
        **/.obsidian/

        # nix build artifacts
        **/result/
        **/result-*

        # project-specific patterns (from commonplace setup)
        pack-toolbox/temp/
        */assets/minecraft/textures/
      '';
    };

    programs = {
      zsh = {
        enable = true;
        initContent = ''
          # homebrew shellenv (darwin only)
          if [[ "$(uname)" == "Darwin" ]]; then
            eval "$(${brewPrefix}/bin/brew shellenv)"
          fi

          # bun (if installed)
          if command -v bun >/dev/null 2>&1; then
            export BUN_INSTALL="$HOME/.bun"
            export PATH="$BUN_INSTALL/bin:$PATH"
          fi

          # sdkman (if installed)
          if [[ -s "$HOME/.sdkman/bin/sdkman-init.sh" ]]; then
            export SDKMAN_DIR="$HOME/.sdkman"
            source "$HOME/.sdkman/bin/sdkman-init.sh"
          fi

          # fnm
          if command -v fnm >/dev/null 2>&1; then
            eval "$(fnm env --use-on-cd --shell zsh)"
          fi

          autoload -Uz compinit
          () {
            if [[ $# -gt 0 ]]; then
              compinit -C
            else
              compinit -C -d "$HOME/.zcompdump-''${HOST}-''${ZSH_VERSION}"
            fi
          } ''${ZDOTDIR:-$HOME}/.zcompdump(N.mh+24)

          # show hidden files in globbing
          setopt GLOB_DOTS

          # fzf defaults
          export FZF_DEFAULT_COMMAND='rg --files --hidden --follow'
          export FZF_CTRL_T_COMMAND="$FZF_DEFAULT_COMMAND"
          export FZF_DEFAULT_OPTS='--height=40% --layout=reverse --border'

          # prompt (minimal)
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
  };
}



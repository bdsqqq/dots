{ lib, config, ... }:
/*
## shell-agnostic config

home-manager provides shell-agnostic options that work across bash, zsh, fish, etc:
- home.shellAliases: aliases for all shells
- home.sessionVariables: environment variables for all shells

## shell integrations

as of jan 2025, home.shell.enableShellIntegration defaults to true.
programs like fzf, zoxide, etc. auto-enable integration for all configured shells.
no need to set enableZshIntegration, enableBashIntegration, etc. unless overriding.
*/
{
  home-manager.users.bdsqqq = { config, pkgs, ... }: {
    xdg.enable = true;
    xdg.userDirs = if pkgs.stdenv.isDarwin then {} else {
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

      ".rgignore".source = config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/commonplace/01_files/nix/config/rgignore";
    };

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

          # show hidden files in globbing
          setopt GLOB_DOTS

          # prompt (minimal with async git)
          autoload -U colors && colors
          setopt PROMPT_SUBST

          typeset -g _git_prompt_info=""
          typeset -g _git_prompt_fd=0

          _git_prompt_done() {
            local fd=$1
            _git_prompt_info="$(<&$fd)"
            zle -F $fd
            exec {fd}>&-
            _git_prompt_fd=0
            zle && zle reset-prompt
          }

          _async_git_prompt() {
            # close previous fd if still open
            (( _git_prompt_fd )) && { zle -F $_git_prompt_fd; exec {_git_prompt_fd}>&-; }
            
            # start async job, open fd to read output
            exec {_git_prompt_fd}< <(
              local b dirty=""
              b=$(git symbolic-ref --short HEAD 2>/dev/null) || b=$(git rev-parse --short HEAD 2>/dev/null) || exit 0
              if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
                dirty="*"
              fi
              print -r -- "[$b]$dirty"
            )
            
            # register callback for when data is ready
            zle -F $_git_prompt_fd _git_prompt_done
          }

          precmd_functions+=(_async_git_prompt)

          PROMPT='%{$fg_bold[white]%}⁂ %c%{$reset_color%}$_git_prompt_info
   %{$fg[white]%}└ %{$reset_color%}'
        '';
      };
    };

    home.shellAliases = {
      l = "ls -lah";
      ll = "ls -l";
      c = "clear";
    };
  };
}


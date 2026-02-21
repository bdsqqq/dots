{ lib, ... }:
{
  home-manager.users.bdsqqq = { config, pkgs, lib, ... }: {
    # define my.defaultShell option here, derived from enabled shell programs
    # other modules (tmux, etc.) can reference config.my.defaultShell
    options.my.defaultShell = lib.mkOption {
      type = lib.types.package;
      default =
        if config.programs.zsh.enable then config.programs.zsh.package
        else if config.programs.fish.enable then config.programs.fish.package
        else pkgs.bash;
      description = "Default shell package, derived from whichever shell is enabled";
    };

    config = {
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
      
      xdg.mimeApps = let
        browser = "app.zen_browser.zen.desktop";  # flatpak
        imageViewer = "imv.desktop";
        videoPlayer = "vlc.desktop";
        fileManager = "yazi.desktop";
      in if pkgs.stdenv.isDarwin then {} else {
        enable = true;
        defaultApplications = {
          # browser
          "text/html" = browser;
          "x-scheme-handler/http" = browser;
          "x-scheme-handler/https" = browser;
          "x-scheme-handler/about" = browser;
          "x-scheme-handler/unknown" = browser;
          
          # images
          "image/png" = imageViewer;
          "image/jpeg" = imageViewer;
          "image/gif" = imageViewer;
          "image/webp" = imageViewer;
          "image/svg+xml" = imageViewer;
          "image/bmp" = imageViewer;
          "image/tiff" = imageViewer;
          
          # video
          "video/mp4" = videoPlayer;
          "video/webm" = videoPlayer;
          "video/x-matroska" = videoPlayer;
          
          # file manager
          "inode/directory" = fileManager;
        };
      };

      home.sessionVariables = {
        EDITOR = "nvim";
        VISUAL = "nvim";
      };

      # directory scaffolding and global ripgrep ignore
      home.file = {
        "commonplace/00_inbox/.keep".text = "";
        "commonplace/01_files/.keep".text = "";
        "commonplace/02_temp/.keep".text = "";

        ".rgignore".source = config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/commonplace/01_files/nix/config/rgignore";
        ".gitignore_global".source = config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/commonplace/01_files/nix/config/ignore-common";

        # syncthing ignore (symlinked so all nix-managed devices share the same config)
        "commonplace/.stignore".source = config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/commonplace/01_files/nix/config/stignore";
      };

      programs = {
        zsh = {
          enable = true;
          dotDir = "${config.xdg.configHome}/zsh";
          history = {
            path = "${config.home.homeDirectory}/commonplace/01_files/.zsh_history";
            size = 100000;
            save = 100000;
            extended = true;
            share = true;
            ignoreDups = true;
            ignoreAllDups = true;
            ignoreSpace = true;
          };
          initContent = ''
          # disable XON/XOFF so ctrl+s is available for keybinds (e.g. sesh)
          stty -ixon 2>/dev/null

          export AMI_INSTALL="$HOME/.ami"
          export PATH="$AMI_INSTALL/bin:$PATH"
          export GH_TOKEN="$(cat /run/secrets/gh_token 2>/dev/null || echo "$GH_TOKEN")"
          export AMP_API_KEY="$(cat /run/secrets/AMP_API_KEY 2>/dev/null || echo "$AMP_API_KEY")"
          export HF_TOKEN="$(cat /run/secrets/hf_token 2>/dev/null || echo "$HF_TOKEN")"
          export PARALLEL_API_KEY="$(cat /run/secrets/parallel_api_key 2>/dev/null || echo "$PARALLEL_API_KEY")"
          export NIX_CONFIG="access-tokens = github.com=$(cat /run/secrets/gh_token 2>/dev/null || echo "")"

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

            # record metadata in history using logfmt format
            zshaddhistory() {
              local cmd="''${1%%$'\n'}"
              # strip existing tag if present (handles re-executed recalled commands)
              cmd="''${cmd%  # *=*}"
              
              # skip trivial commands (return 2 = don't save, don't error)
              [[ "$cmd" =~ ^[[:space:]]*(exit|ls|ll|l|bg|fg|history|clear|c|cd|pwd|\.\.)$ ]] && return 2
              
              # get dir basename (like prompt %c)
              local dir="''${PWD:t}"
              # quote dir if it contains spaces or special chars
              if [[ "$dir" =~ [[:space:]=\"\'] ]]; then
                dir="\"''${dir//\"/\\\"}\""
              fi
              
              local tag="user=''${USER} host=''${HOST} dir=''${dir}"
              
              # add agent info if running in agent context
              if [[ -n "$AGENT" && -n "$AGENT_THREAD_ID" ]]; then
                local short_thread="''${AGENT_THREAD_ID##*-}"
                short_thread="''${short_thread:0:8}"
                tag="user=''${USER} agent=''${AGENT} thread=''${short_thread} host=''${HOST} dir=''${dir}"
              fi
              
              print -sr -- "''${cmd}  # ''${tag}"
              return 1  # prevent default history add
            }

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

            # auto-reload shell when nix generation changes
            typeset -g _nix_gen_cached=""
            _nix_gen_check() {
              local gen_file="/run/current-system/sw/darwin-version"
              local current=$(cat "$gen_file" 2>/dev/null)
              if [[ -n "$_nix_gen_cached" && -n "$current" && "$current" != "$_nix_gen_cached" ]]; then
                exec zsh
              fi
              _nix_gen_cached="$current"
            }
            precmd_functions+=(_nix_gen_check)

            # strip logfmt tag from history recall (up arrow)
            _strip_history_tag() {
              zle up-line-or-history
              BUFFER="''${BUFFER%  \# *=*}"
            }
            zle -N up-line-or-history-clean _strip_history_tag
            bindkey '^[[A' up-line-or-history-clean  # up arrow
            bindkey '^[OA' up-line-or-history-clean  # up arrow (alternate)

            PROMPT='%{$fg_bold[white]%}⁂ %c%{$reset_color%}$_git_prompt_info
   %{$fg[white]%}└ %{$reset_color%}'
          '';
        };
      };

      home.shellAliases = {
        ls = "eza";
        l = "eza -lah --git --icons";
        ll = "eza -l --git --icons";
        la = "eza -a --git --icons";
        lt = "eza --tree --level=2 --icons";
        c = "clear";
      };


    };
  };
}

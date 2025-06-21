{ config, pkgs, lib, ... }:

{
  # Home Manager needs a bit of information about you and the
  # paths it should manage.
  home.username = "bdsqqq";
  home.homeDirectory = "/Users/bdsqqq";

  # sops-nix configuration for secrets management (optional)
  sops = lib.mkIf (builtins.pathExists ./secrets.yaml) {
    # age key file location (never commit this!)
    age.keyFile = "/Users/bdsqqq/.config/sops/age/keys.txt";
    
    # default secrets file location
    defaultSopsFile = ./secrets.yaml;
    
    # secrets definitions go here
    secrets = {
      # api keys
      anthropic_api_key = {};
      copilot_token = {};
    };
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
      sessionVariables = {
        GOPATH = "$HOME/go";
        PNPM_HOME = "$HOME/Library/pnpm";
        BUN_INSTALL = "$HOME/.bun";
        SDKMAN_DIR = "$HOME/.sdkman";
      };
      shellAliases = {
        # Add your custom aliases here
      };
      initContent = ''
        # PATH additions
        export PATH="$GOPATH/bin:$PATH"
        export PATH="$HOME/.scripts:$PATH"
        export PATH="$PNPM_HOME:$PATH"
        export PATH="$BUN_INSTALL/bin:$PATH"
        
        # Tool initializations
        eval "$(/opt/homebrew/bin/brew shellenv)"
        eval "$(fnm env --use-on-cd)"

        # bun completions
        [[ -s "$HOME/.bun/_bun" ]] && source "$HOME/.bun/_bun"

        # SDKMAN
        [[ -s "$HOME/.sdkman/bin/sdkman-init.sh" ]] && source "$HOME/.sdkman/bin/sdkman-init.sh"
        
        # API Keys with fallback behavior
        # Try sops secrets first, fallback to existing env vars
        ${lib.optionalString (builtins.pathExists ./secrets.yaml && config.sops.secrets ? anthropic_api_key) ''
          export ANTHROPIC_API_KEY="$(cat ${config.sops.secrets.anthropic_api_key.path} 2>/dev/null || echo "$ANTHROPIC_API_KEY")"
        ''}
        ${lib.optionalString (builtins.pathExists ./secrets.yaml && config.sops.secrets ? copilot_token) ''
          export GITHUB_COPILOT_TOKEN="$(cat ${config.sops.secrets.copilot_token.path} 2>/dev/null || echo "$GITHUB_COPILOT_TOKEN")"
        ''}
        
        # If no sops secrets, just use env vars as-is
        ${lib.optionalString (!builtins.pathExists ./secrets.yaml) ''
          # No secrets file found, using environment variables
          export ANTHROPIC_API_KEY="''${ANTHROPIC_API_KEY:-}"
          export GITHUB_COPILOT_TOKEN="''${GITHUB_COPILOT_TOKEN:-}"
        ''}
      '';
    };
    # qutebrowser = import ./qutebrowser.nix;
    # neomutt = import ./email/neomutt.nix;
    # notmuch = import ./email/notmuch.nix;
    # mbsync = import ./email/mbsync.nix;
    # khal = import ./calendar/khal.nix;
    # mpv = import ./mpv.nix;
    # zk = import ./zk/zk.nix;
    yt-dlp = {
      enable = true;
      settings = {
        sub-lang = "en.*";
      };
    };
    spotify-player = {
      enable = true;
    };
    # # taskwarrior = {
    # #   enable = true;
    # #   dataLocation = "/home/dot/.config/task";
    # #   package = pkgs.taskwarrior3;
    # # };
    # # vdirsyncer = {
    # #   enable = true;
    # # };
    # kitty = {
    #   enable = true;
    #   shellIntegration.enableZshIntegration = true;
    #   font = {
    #     name = "Meslo Nerd Font";
    #     size = 13;
    #   };
    #   themeFile = "Catppuccin-Mocha";
    #   settings = {
    #     enable_audio_bell = false;
    #     dynamic_background_opacity = true;
    #   };
    # };
    # pidgin = {
    #   enable = true;
    #   plugins = with pkgs.pidginPackages; [
    #     # pkgs.pidginPackages.tdlib-purple #broken
    #     purple-discord
    #     purple-facebook
    #     purple-signald
    #   ];
    # };
    # tmux = {
    #   enable = true;
    #   terminal = "tmux-256color";
    #   plugins = with pkgs;
    #     [
    #       tmuxPlugins.vim-tmux-navigator
    #       tmuxPlugins.catppuccin
    #     ];
    #   extraConfig = ''
    #     set -g @catppuccin_flavour 'mocha'
    #     set-option -sg escape-time 10
    #     set-option -sa terminal-features ',xterm-kitty:RGB'
    #     set-window-option -g  mode-keys vi
    #     bind-key -T copy-mode-vi v send -X begin-selection
    #     bind-key -T copy-mode-vi V send -X select-line
    #     bind-key -T copy-mode-vi y send -X copy-pipe-and-cancel 'xclip -in -selection clipboard'
    #   '';
    # };
    fzf = {
      enable = true;
      enableZshIntegration = true;
    };
    git = {
      enable = true;
      userEmail = "igorbedesqui@gmail.com";
      userName = "Igor Bedesqui";
      lfs.enable = true;
      extraConfig = {
        init.defaultBranch = "main";
        gitreview = {
          remote = "origin";
          username = "bdsqqq";
        };
      };
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
      local STATUS='''
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
      if [ "$branch" = ''' ]; then
        # not a git repo
        echo '''
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

  home.packages = with pkgs; [
    lazygit
    mpv
    sops
    age
    ssh-to-age
    fnm
    oh-my-zsh
    amp-cli
    ripgrep
    fd
    bat
    eza
    btop
    curl
    wget
    jq
    tree
    asciiquarium-transparent
    fastfetch
  ];

  # This value determines the Home Manager release that your
  # configuration is compatible with. This helps avoid breakage
  # when a new Home Manager release introduces backwards
  # incompatible changes.
  #
  # You can update Home Manager without changing this value. See
  # the Home Manager release notes for a list of state version
  # changes in each release.
  home.stateVersion = "25.05";

  # Let Home Manager install and manage itself.
  programs.home-manager.enable = true;

}
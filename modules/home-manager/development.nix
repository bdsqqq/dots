{ config, pkgs, lib, isDarwin ? false, ... }:

{
  programs = {
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

    yt-dlp = {
      enable = true;
      settings = {
        sub-lang = "en.*";
      };
    };

    spotify-player = {
      enable = true;
    };

    zsh = {
      sessionVariables = {
        GOPATH = "$HOME/go";
        PNPM_HOME = "$HOME/Library/pnpm";
        BUN_INSTALL = "$HOME/.bun";
        SDKMAN_DIR = "$HOME/.sdkman";
        PYTHONPATH = "$HOME/.local/lib/python3.12/site-packages";
        PIP_USER = "true";
        PYTHONDONTWRITEBYTECODE = "1";
        PYTHONUNBUFFERED = "1";
      };
      initContent = ''
        eval "$(/opt/homebrew/bin/brew shellenv)"
        eval "$(fnm env --use-on-cd)"
        
        # Install and use Node.js v22 LTS by default
        if ! fnm ls | grep -q "v22"; then
          fnm install 22
        fi
        fnm default 22
        
        [[ -s "$HOME/.bun/_bun" ]] && source "$HOME/.bun/_bun"
        [[ -s "$HOME/.sdkman/bin/sdkman-init.sh" ]] && source "$HOME/.sdkman/bin/sdkman-init.sh"
        export PATH="/etc/profiles/per-user/bdsqqq/bin:$HOME/.nix-profile/bin:$GOPATH/bin:$HOME/.scripts:$PNPM_HOME:$BUN_INSTALL/bin:$HOME/.local/bin:$HOME/commonplace/01_files/scripts:$PATH"
        
        alias venv='python3 -m venv'
        alias activate='source venv/bin/activate'
        alias py='python3'
        alias pip3='python3 -m pip'
        
        export POETRY_VENV_IN_PROJECT=true
        
        # Sops secrets are optional
        ${lib.optionalString (config ? sops && config.sops ? secrets && config.sops.secrets ? anthropic_api_key) ''
          export ANTHROPIC_API_KEY="$(cat ${config.sops.secrets.anthropic_api_key.path} 2>/dev/null || echo "$ANTHROPIC_API_KEY")"
        ''}
      '';
    };
  };

  home.packages = with pkgs; [
    lazygit
    gh
    graphite-cli
    git-filter-repo
    exiftool
    sops
    age
    ssh-to-age
    fnm
    oh-my-zsh

    pnpm
    pscale
    go
    gofumpt
    golangci-lint
    gotools
    gopls
    gotests
    delve
    ripgrep
    fd
    bat
    eza
    btop
    ctop
    lazydocker
    curl
    wget
    jq
    yq
    tree
    tailscale
    p7zip
    cloc
    stow
    yazi
    tmux
    ffmpeg
    httpie
    asciiquarium-transparent
    fastfetch
    
  ];
  # Note: ghostty is now configured in applications.nix for both platforms
}

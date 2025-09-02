# workbench packages - development tools for day-to-day work
{ config, pkgs, lib, ... }:

{
  home.packages = with pkgs; [
    # enhanced git tools
    lazygit
    delta
    gh
    graphite-cli
    git-filter-repo
    
    # enhanced shell tools
    eza
    yazi
    stow
    cloc
    
    # programming languages and runtimes
    nodejs_22
    pnpm
    python3
    uv
    go
    
    # go development tools
    gofumpt
    golangci-lint
    gotools
    gopls
    gotests
    delve
    
    # development utilities
    fnm
    pscale
    docker
    lazydocker
    ctop
    
    # media and content tools
    yt-dlp
    gallery-dl
    ffmpeg
    exiftool
    
    # networking and api tools
    httpie
    
    # security tools
    sops
    age
    ssh-to-age
    
    # cloud tools
    rclone
    
    # fun utilities
    fastfetch
    asciiquarium-transparent
    oh-my-zsh
  ];

  programs = {
    git.extraConfig = {
      gitreview = {
        remote = "origin";
        username = "bdsqqq";
      };
      core.pager = "delta";
      interactive.diffFilter = "delta --color-only";
      delta = {
        navigate = true;
        dark = true;
      };
      merge.conflictstyle = "zdiff3";
    };

    yt-dlp = {
      enable = true;
      settings = {
        sub-lang = "en.*";
      };
    };

    gallery-dl.enable = true;
    spotify-player.enable = true;

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
        # nix-managed nodejs is preferred over fnm for stability
        [[ -s "$HOME/.bun/_bun" ]] && source "$HOME/.bun/_bun"
        [[ -s "$HOME/.sdkman/bin/sdkman-init.sh" ]] && source "$HOME/.sdkman/bin/sdkman-init.sh"
        export PATH="/etc/profiles/per-user/bdsqqq/bin:$HOME/.nix-profile/bin:$GOPATH/bin:$HOME/.scripts:$PNPM_HOME:$BUN_INSTALL/bin:$HOME/.local/bin:$HOME/commonplace/01_files/scripts:$PATH"
        
        alias venv='python3 -m venv'
        alias activate='source venv/bin/activate'
        alias py='python3'
        alias pip3='python3 -m pip'
        
        export POETRY_VENV_IN_PROJECT=true
        
        # sops secrets are optional
        ${lib.optionalString (config ? sops && config.sops ? secrets && config.sops.secrets ? anthropic_api_key) ''
          export ANTHROPIC_API_KEY="$(cat ${config.sops.secrets.anthropic_api_key.path} 2>/dev/null || echo "$ANTHROPIC_API_KEY")"
        ''}
      '';
    };
  };
}
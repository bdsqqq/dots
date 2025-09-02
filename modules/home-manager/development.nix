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
        core.pager = "delta";
        interactive.diffFilter = "delta --color-only";
        delta = {
          navigate = true;  # use n and N to move between diff sections
          dark = true;      # or light = true, or omit for auto-detection
        };
        merge.conflictstyle = "zdiff3";
      };
    };

    yt-dlp = {
      enable = true;
      settings = {
        sub-lang = "en.*";
      };
    };

    gallery-dl = {
      enable = true;
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
        # Use nix-managed nodejs instead of fnm to avoid dynamic linking issues on nixos
        # eval "$(fnm env --use-on-cd)"
        
        # Install and use Node.js v22 LTS by default
        # if ! fnm ls | grep -q "v22"; then
        #   fnm install 22
        # fi
        # fnm default 22
        
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
    delta
    gh
    graphite-cli
    git-filter-repo
    exiftool
    sops
    age
    ssh-to-age
    fnm
    oh-my-zsh
    nodejs_22

    pnpm
    pscale
    go
    python3
    uv
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
  ] ++ lib.optionals isDarwin [
    # macOS system monitoring (includes GPU info)
    istat-menus
  ] ++ lib.optionals (!isDarwin) [
    nvtopPackages.nvidia
  ];
  # Note: ghostty is now configured in applications.nix for both platforms
}

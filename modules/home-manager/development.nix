{ config, pkgs, lib, ... }:

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
      };
      initExtra = ''
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
        ${lib.optionalString (builtins.pathExists ../../secrets.yaml && config.sops.secrets ? anthropic_api_key) ''
          export ANTHROPIC_API_KEY="$(cat ${config.sops.secrets.anthropic_api_key.path} 2>/dev/null || echo "$ANTHROPIC_API_KEY")"
        ''}
        ${lib.optionalString (builtins.pathExists ../../secrets.yaml && config.sops.secrets ? copilot_token) ''
          export GITHUB_COPILOT_TOKEN="$(cat ${config.sops.secrets.copilot_token.path} 2>/dev/null || echo "$GITHUB_COPILOT_TOKEN")"
        ''}
        
        # If no sops secrets, just use env vars as-is
        ${lib.optionalString (!builtins.pathExists ../../secrets.yaml) ''
          # No secrets file found, using environment variables
          export ANTHROPIC_API_KEY="''${ANTHROPIC_API_KEY:-}"
          export GITHUB_COPILOT_TOKEN="''${GITHUB_COPILOT_TOKEN:-}"
        ''}
      '';
    };
  };

  home.packages = with pkgs; [
    # Git tools
    lazygit

    # Media tools
    mpv

    # Security/secrets
    sops
    age
    ssh-to-age

    # Development tools
    fnm
    oh-my-zsh
    amp-cli

    # CLI utilities
    ripgrep
    fd
    bat
    eza
    btop
    curl
    wget
    jq
    tree

    # Fun stuff
    asciiquarium-transparent
    fastfetch
  ];
}

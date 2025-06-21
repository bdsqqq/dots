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
        # GOROOT will be set by nix-managed Go
        PNPM_HOME = "$HOME/Library/pnpm";
        BUN_INSTALL = "$HOME/.bun";
        SDKMAN_DIR = "$HOME/.sdkman";

        # Python environment configuration
        PYTHONPATH = "$HOME/.local/lib/python3.12/site-packages";
        PIP_USER = "true"; # Enable user-level pip installs
        PYTHONDONTWRITEBYTECODE = "1"; # Don't write .pyc files
        PYTHONUNBUFFERED = "1"; # Unbuffered output for better logging
      };
      initExtra = ''
        # Load homebrew to get base environment
        eval "$(/opt/homebrew/bin/brew shellenv)"
        
        # Initialize nix-managed fnm for Node.js version management
        eval "$(fnm env --use-on-cd)"

        # bun completions
        [[ -s "$HOME/.bun/_bun" ]] && source "$HOME/.bun/_bun"

        # SDKMAN
        [[ -s "$HOME/.sdkman/bin/sdkman-init.sh" ]] && source "$HOME/.sdkman/bin/sdkman-init.sh"
        
        # FINAL PATH setup - Ensure nix-managed tools take absolute precedence
        # This must be LAST to override all previous PATH modifications
        export PATH="/etc/profiles/per-user/bdsqqq/bin:$HOME/.nix-profile/bin:$GOPATH/bin:$HOME/.scripts:$PNPM_HOME:$BUN_INSTALL/bin:$HOME/.local/bin:$PATH"
        
        # Python virtual environment helpers
        alias venv='python3 -m venv'
        alias activate='source venv/bin/activate'
        alias py='python3'
        alias pip3='python3 -m pip'
        
        # Poetry configuration for nix-managed Python
        export POETRY_VENV_IN_PROJECT=true
        
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
    git-filter-repo # Advanced git repository rewriting

    # Media tools
    mpv
    exiftool # Read and write metadata in files
    # jp2a # Convert images to ASCII art - currently broken in nixpkgs

    # Security/secrets
    sops
    age
    ssh-to-age

    # Development tools
    fnm # nix-managed fnm for Node.js version management
    oh-my-zsh
    amp-cli

    # Node.js development tools
    # NOTE: nodejs removed - fnm will manage Node.js versions
    # Global Node.js tools installed per-project or via fnm
    pnpm # Fast, disk space efficient package manager  
    bun # Fast all-in-one JavaScript runtime

    # Python development tools
    python312 # Python 3.12 (current stable, default)
    python312Packages.pip # Package installer  
    python312Packages.virtualenv # Virtual environment creation
    pipenv # Higher-level venv/pip workflow (standalone package)
    poetry # Modern dependency management (standalone package)

    # Python development tools
    python312Packages.black # Code formatter
    python312Packages.isort # Import sorter
    python312Packages.mypy # Static type checker
    ruff # Fast Python linter/formatter (rust-based)
    python312Packages.pytest # Testing framework
    python312Packages.ipython # Enhanced interactive shell
    python312Packages.certifi # SSL certificates bundle
    python312Packages.packaging # Core utilities for Python packages

    # Alternative Python versions (available on-demand)
    # python39   # Use when needed for legacy projects
    # python311  # Use when needed for compatibility
    # python313  # Use unstable for bleeding-edge: pkgs.unstable.python313

    # Go development tools
    go # Latest stable Go version
    # For unstable/bleeding-edge Go, use: pkgs.unstable.go
    gofumpt # Stricter gofmt
    golangci-lint # Go linter
    gotools # Includes goimports, godoc, etc.
    gopls # Go language server
    gotests # Generate Go tests
    delve # Go debugger

    # CLI utilities
    ripgrep
    fd
    bat
    eza
    btop
    curl
    wget
    jq
    yq # YAML processor (jq for YAML)
    tree
    tailscale
    
    # System utilities (Tier 2)
    p7zip # 7-Zip archiver
    cloc # Count lines of code
    stow # Symlink farm manager
    neofetch # System information display
    
    # Terminal management
    tmux # Terminal multiplexer

    # Fun stuff
    asciiquarium-transparent
    fastfetch

    # Tier 3 CLI Tools - Complex migration candidates
    # Container & Docker management tools
    lazydocker # Docker management TUI (replacement for GUI Docker Desktop features)
    
    # Development CLI tools
    swagger-codegen # OpenAPI/Swagger code generation
    swagger-cli # Swagger/OpenAPI validation and bundling
    go-swagger # More powerful Swagger toolkit for Go
    
    # Media processing tools
    ffmpeg # Video/audio processing (consolidates multiple homebrew media tools)
    
    # Database & backend development tools  
    supabase-cli # Supabase project management and development
    
    # Cloud & Infrastructure tools
    awscli2 # AWS command line interface (v2)
    azure-cli # Microsoft Azure command line interface
    
    # HTTP/API testing tools
    httpie # Modern curl replacement with JSON support
    
    # System monitoring and container tools
    htop # Interactive process viewer (better than top)
    dive # Tool for exploring Docker images
    ctop # Container monitoring tool
    
    # DevOps and automation tools
    ansible # Infrastructure automation platform
  ];
}

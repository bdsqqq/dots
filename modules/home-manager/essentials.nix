{ config, pkgs, lib, isDarwin ? false, ... }:

{
  # Essential CLI tools for development work on any machine
  home.packages = with pkgs; [
    # Version control
    git
    lazygit
    delta
    gh
    graphite-cli

    # Text processing and search
    ripgrep
    fd
    bat
    eza
    tree

    # Networking and data
    curl
    wget
    jq
    yq
    tailscale

    # System monitoring and utilities
    btop
    p7zip
    stow
    yazi
    tmux
    cloc

    # Containerization
    docker
    lazydocker

    # Cloud storage
    rclone

    # Security and encryption
    sops
    age
    ssh-to-age

    # Programming languages and runtimes
    nodejs_22
    pnpm
    pscale
    go
    python3
    uv

    # Development tools
    gofumpt
    golangci-lint
    gotools
    gopls
    gotests
    delve
    fnm
    oh-my-zsh

    # Media processing
    yt-dlp
    gallery-dl
    ffmpeg
    exiftool

    # Additional CLI tools
    httpie
    fastfetch
    asciiquarium-transparent
    ctop
    git-filter-repo
  ] ++ lib.optionals isDarwin [
    # macOS system monitoring
    istat-menus
  ] ++ lib.optionals (!isDarwin) [
    # Linux system monitoring
    nvtopPackages.nvidia
  ];
}
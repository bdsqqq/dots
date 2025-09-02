# base packages - minimal platform-agnostic cli tools for all machines
{ config, pkgs, lib, ... }:

{
  home.packages = with pkgs; [
    # essential system utilities
    curl
    wget
    tailscale
    
    # text processing
    ripgrep
    fd
    bat
    tree
    
    # archive handling
    p7zip
    
    # data processing
    jq
    yq
    
    # version control (minimal)
    git
    
    # system monitoring
    btop
    
    # shell enhancement
    zsh
    tmux
  ];

  programs.git = {
    enable = true;
    userEmail = "igorbedesqui@gmail.com";
    userName = "Igor Bedesqui";
    extraConfig = {
      init.defaultBranch = "main";
    };
  };

  programs.zsh.enable = true;
}
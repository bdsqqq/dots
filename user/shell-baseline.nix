{ lib, pkgs, hostSystem ? null, ... }:
{
  imports = [
    ./path-order.nix
    ./shell.nix
    ./ssh.nix
    ./btop
    ./homebrew.nix
    ./fzf
    ./zoxide.nix
    ./nvim
    ./git
    ./tealdeer.nix
    ./trash.nix
    (import ../zmx.nix).module
    ./direnv.nix
    ./tmux.nix
    ./amp.nix
    ./agents
  ];

  home-manager.users.bdsqqq.home.packages =
    (with pkgs; [
      coreutils
      ripgrep
      ast-grep
      fd
      bat
      eza
      curl
      wget
      jq
      yq
      tree
      p7zip
      cloc
      stow
      yazi
      httpie
      fastfetch
    ])
    ++ lib.optionals (lib.hasInfix "linux" hostSystem) [ pkgs.cloudflared ];
}

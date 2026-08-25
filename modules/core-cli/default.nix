{ lib, pkgs, hostSystem ? null, ... }:
{
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

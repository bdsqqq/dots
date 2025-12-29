{ lib, hostSystem ? null, config, ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  brewPrefix = if isDarwin then config.homebrew.brewPrefix or "/opt/homebrew" else "";
in
{
  home-manager.users.bdsqqq = { config, pkgs, ... }: {
    programs.zsh.initContent = lib.mkIf isDarwin ''
      # homebrew shellenv (darwin only)
      eval "$(${brewPrefix}/brew shellenv)"
    '';
  };
}

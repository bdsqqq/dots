{ lib, hostSystem ? null, config, ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  prefix = if isDarwin then config.homebrew.prefix or "/opt/homebrew" else "";
in
{
  home-manager.users.bdsqqq = { config, pkgs, ... }: {
    programs.zsh.initContent = lib.mkIf isDarwin ''
      # homebrew shellenv (darwin only)
      eval "$(${prefix}/bin/brew shellenv)"
    '';
    programs.bash.initExtra = lib.mkIf isDarwin ''
      # homebrew shellenv (darwin only)
      eval "$(${prefix}/bin/brew shellenv)"
    '';
  };
}

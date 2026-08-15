{ lib, hostSystem ? null, config, ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  prefix = if isDarwin then config.homebrew.prefix or "/opt/homebrew" else "";
in
lib.optionalAttrs isDarwin {
  homebrew.brews = [ "cloudflared" ];

  home-manager.users.bdsqqq = { config, pkgs, ... }: {
    programs.zsh.initContent = ''
      # homebrew shellenv (darwin only)
      eval "$(${prefix}/bin/brew shellenv)"
    '';
    programs.bash.initExtra = ''
      # homebrew shellenv (darwin only)
      eval "$(${prefix}/bin/brew shellenv)"
    '';
  };
}

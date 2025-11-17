{ config, pkgs, ... }:
{
  home-manager.users.bdsqqq = { config, pkgs, ... }: {
    programs.zsh.initExtra = ''
      # fnm
      if command -v fnm >/dev/null 2>&1; then
        eval "$(fnm env --use-on-cd --shell zsh)"
      fi
    '';
  };
}

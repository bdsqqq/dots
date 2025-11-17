{ config, pkgs, ... }:
{
  home-manager.users.bdsqqq = { config, pkgs, ... }: {
    programs.zsh.initExtra = ''
      # bun (if installed)
      if command -v bun >/dev/null 2>&1; then
        export BUN_INSTALL="$HOME/.bun"
        export PATH="$BUN_INSTALL/bin:$PATH"
      fi
    '';
  };
}

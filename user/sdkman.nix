{ config, pkgs, ... }:
{
  home-manager.users.bdsqqq = { config, pkgs, ... }: {
    programs.zsh.initExtra = ''
      # sdkman (lazy-load on first use)
      if [[ -s "$HOME/.sdkman/bin/sdkman-init.sh" ]]; then
        export SDKMAN_DIR="$HOME/.sdkman"
        sdk() {
          unfunction sdk
          source "$HOME/.sdkman/bin/sdkman-init.sh"
          sdk "$@"
        }
      fi
    '';
  };
}

{ config, pkgs, ... }: {
  home-manager.users.bdsqqq = { config, pkgs, ... }: {
    home.file.".node-version".text = "22.19.0";
    programs.zsh.initContent = ''
      # fnm
      if command -v fnm >/dev/null 2>&1; then
        eval "$(fnm env --use-on-cd --shell zsh)"
      fi
    '';
  };
}

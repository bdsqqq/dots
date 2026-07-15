{ config, pkgs, ... }: {
  home-manager.users.bdsqqq = { config, pkgs, ... }: {
    home.file.".node-version".text = "24.18.0";
    programs.zsh.initContent = ''
      # fnm
      if [[ -t 1 ]] && command -v fnm >/dev/null 2>&1; then
        eval "$(fnm env --use-on-cd --shell zsh)"
      fi
    '';
  };
}

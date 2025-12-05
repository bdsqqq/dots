{ config, pkgs, ... }:
{
  home-manager.users.bdsqqq = { config, pkgs, ... }: {
    programs.fzf = {
      enable = true;
      defaultCommand = "rg --files --hidden --follow";
      defaultOptions = [
        "--height=40%"
        "--layout=reverse"
        "--border"
      ];
    };

    programs.zsh.initExtra = ''
      # custom fzf file widget (ctrl+f)
      _fzf_files() {
        local selected=$(rg --files --hidden --follow | fzf --height=40% --layout=reverse --border)
        LBUFFER="''${LBUFFER}''${selected}"
        zle reset-prompt
      }
      zle -N _fzf_files
      bindkey '^F' _fzf_files
    '';
  };
}

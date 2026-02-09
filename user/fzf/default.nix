{ config, pkgs, ... }:

let
  awkScript = ./history-format.awk;
  
  historyWidget = builtins.replaceStrings
    [ "@gawk@" "@awkScript@" "@tac@" ]
    [ "${pkgs.gawk}/bin/gawk" "${awkScript}" "${pkgs.coreutils}/bin/tac" ]
    (builtins.readFile ./history-widget.zsh);
in
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

    programs.zsh.initContent = ''
      # custom fzf file widget (ctrl+f)
      _fzf_files() {
        local selected=$(rg --files --hidden --follow | fzf --height=40% --layout=reverse --border)
        LBUFFER="''${LBUFFER}''${selected}"
        zle reset-prompt
      }
      zle -N _fzf_files
      bindkey '^F' _fzf_files

      ${historyWidget}
    '';
  };
}

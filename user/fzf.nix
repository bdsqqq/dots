{ config, pkgs, ... }:
{
  home-manager.users.bdsqqq = { config, pkgs, ... }: {
    home.sessionVariables = {
      # disable fzf auto-bindings, use manual keybinds instead
      FZF_CTRL_T_COMMAND = "";
      FZF_CTRL_R_COMMAND = "";
    };

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
      # fzf custom keybindings
      bindkey '^F' fzf-file-widget
      bindkey '^[[1;5A' fzf-history-widget  # ctrl+up
    '';
  };
}

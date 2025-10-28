{ lib, hostSystem ? null, ... }:
{
  home-manager.users.bdsqqq = { pkgs, ... }: {
    programs.tmux = {
      enable = true;
      keyMode = "vi";
      prefix = "C-Space";
      mouse = true;
      plugins = with pkgs.tmuxPlugins; [
        sensible
        yank
        vim-tmux-navigator
      ];
      extraConfig = ''
        # ensure tmux uses zsh (login) instead of sh/bash
        set-option -g default-shell "/bin/zsh"
        set-option -g default-command "/bin/zsh -l"

        # reload config with <prefix> r
        bind r source-file ~/.tmux.conf \; display-message "tmux reloaded"

        # pane movement with <prefix> h/j/k/l
        bind h select-pane -L
        bind j select-pane -D
        bind k select-pane -U
        bind l select-pane -R
      '';
    };
  };
}

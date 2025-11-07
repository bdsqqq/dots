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
        bind r source-file ~/.config/tmux/tmux.conf \; display-message "tmux reloaded"

        # pane movement with <prefix> h/j/k/l
        bind h select-pane -L
        bind j select-pane -D
        bind k select-pane -U
        bind l select-pane -R

        # minimal statusline tuned for vim-tpipeline interop
        set-option -g status-position top
        set-option -g status-style "bg=default,fg=colour7"
        set-option -g status-interval 0
        set-option -g status-left-length 0
        set-option -g status-right-length 0
        set-option -g status-left ""
        set-option -g status-right ""
        set-option -g status-justify left

        set-option -g window-status-style "bg=default,fg=colour6"
        set-option -g window-status-current-style "bg=default,fg=colour15,bold"
        set-option -g window-status-format " #[fg=colour6][#I #W]#[default] "
        set-option -g window-status-current-format " #[fg=colour13,bold][#I #W]#[default] "

        set-option -g pane-border-style "fg=colour8"
        set-option -g pane-active-border-style "fg=colour7"
        set-option -g message-style "bg=default,fg=colour15"
        set-option -g message-command-style "bg=default,fg=colour15"
      '';
    };
  };
}

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
        bind-key Tab next-window
        bind-key -r S-Tab previous-window
        unbind-key c
        unbind-key &

        # minimal statusline tuned for vim-tpipeline interop
        set-option -g base-index 1
        set-window-option -g pane-base-index 1
        set-option -g renumber-windows on
        set-option -g status-position top
        set-option -g status-style "bg=default,fg=colour7"
        set-option -g status-interval 0
        set-option -g status-left-length 0
        set-option -g status-right-length 0
        set-option -g status-left ""
        set-option -g status-right ""
        set-option -g status-justify right

        set-option -g window-status-style "bg=default,fg=colour6"
        set-option -g window-status-current-style "bg=default,fg=colour15,bold"
        set-option -g window-status-format " #[fg=colour6][#I #W]#[default] "
        set-option -g window-status-current-format " #[fg=colour13,bold][#I #W]#[default] "

        set-option -g pane-border-style "fg=colour8"
        set-option -g pane-active-border-style "fg=colour7"
        set-option -g message-style "bg=default,fg=colour15"
        set-option -g message-command-style "bg=default,fg=colour15"

        # window selection helpers with graceful fallback
        bind-key 1 if-shell -F "#{<=:1,#{session_windows}}" "select-window -t :1" "select-window -t :#{session_windows}"
        bind-key 2 if-shell -F "#{<=:2,#{session_windows}}" "select-window -t :2" "select-window -t :#{session_windows}"
        bind-key 3 if-shell -F "#{<=:3,#{session_windows}}" "select-window -t :3" "select-window -t :#{session_windows}"
        bind-key 4 if-shell -F "#{<=:4,#{session_windows}}" "select-window -t :4" "select-window -t :#{session_windows}"
        bind-key 5 if-shell -F "#{<=:5,#{session_windows}}" "select-window -t :5" "select-window -t :#{session_windows}"
        bind-key 6 if-shell -F "#{<=:6,#{session_windows}}" "select-window -t :6" "select-window -t :#{session_windows}"
        bind-key 7 if-shell -F "#{<=:7,#{session_windows}}" "select-window -t :7" "select-window -t :#{session_windows}"
        bind-key 8 if-shell -F "#{<=:8,#{session_windows}}" "select-window -t :8" "select-window -t :#{session_windows}"
        bind-key 9 if-shell -F "#{<=:9,#{session_windows}}" "select-window -t :9" "select-window -t :#{session_windows}"
        bind-key t new-window -c "#{pane_current_path}"

        # session/window lifecycle shortcuts
        bind-key w confirm-before -p "Kill window #I (#W)? (y/n)" kill-window
        bind-key W confirm-before -p "Kill session #S? (y/n)" kill-session
        bind-key q confirm-before -p "Kill the tmux server? (y/n)" kill-server
      '';
    };
  };
}

{ lib, hostSystem ? null, ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  copyCommand = if isDarwin then "pbcopy" else "wl-copy";
in
{
  home-manager.users.bdsqqq = { pkgs, ... }: {
    programs.tmux = {
      enable = true;
      package = pkgs.tmux;
      
      prefix = "C-Space";
      terminal = "tmux-256color";
      mouse = true;
      escapeTime = 0;
      baseIndex = 1;
      
      extraConfig = ''
        # theme colors matching zellij
        set -g status-style "bg=#101010,fg=#c2c2c2"
        set -g pane-border-style "fg=#374151"
        set -g pane-active-border-style "fg=#6b7280"
        set -g message-style "bg=#101010,fg=#c2c2c2"
        set -g message-command-style "bg=#101010,fg=#c2c2c2"
        
        # status bar (minimal, tabs on right like zjstatus)
        set -g status-position top
        set -g status-justify right
        set -g status-left '#(cat #{socket_path}-#{session_id}-vimbridge)'
        set -g status-left-length 99
        set -g status-right ""
        set -g status-right-length 0
        set -g focus-events on
        
        # window list formatting (matches zjstatus tab style)
        set -g window-status-format "#[fg=#6b7280][#W]#[default] "
        set -g window-status-current-format "#[fg=#d1d5db,bold][#W]#[default] "
        set -g window-status-separator ""
        
        # pane settings
        set -g pane-border-lines single
        set -g pane-border-indicators off
        
        # copy mode with vim keys
        set -g mode-keys vi
        bind -T copy-mode-vi v send -X begin-selection
        bind -T copy-mode-vi y send -X copy-pipe-and-cancel "${copyCommand}"
        
        # prefix + h/j/k/l: move focus between panes
        bind h select-pane -L
        bind j select-pane -D
        bind k select-pane -U
        bind l select-pane -R
        bind Left select-pane -L
        bind Down select-pane -D
        bind Up select-pane -U
        bind Right select-pane -R
        
        # prefix + Tab / Shift+Tab: next/previous window
        bind Tab next-window
        bind BTab previous-window
        
        # prefix + 1-9: go to window by number (already default, but explicit)
        bind 1 select-window -t 1
        bind 2 select-window -t 2
        bind 3 select-window -t 3
        bind 4 select-window -t 4
        bind 5 select-window -t 5
        bind 6 select-window -t 6
        bind 7 select-window -t 7
        bind 8 select-window -t 8
        bind 9 select-window -t 9
        
        # prefix + t: new window
        bind t new-window
        
        # prefix + w: close window
        bind w kill-window
        
        # prefix + W or q: quit session
        bind W kill-session
        bind q kill-session
        
        # prefix + | and -: split panes
        bind | split-window -h -c "#{pane_current_path}"
        bind - split-window -v -c "#{pane_current_path}"
        
        # prefix + Ctrl+Space or Esc: cancel (send-prefix for double tap)
        bind C-Space send-prefix
        bind Escape copy-mode
        
        # automatic window renaming (let zsh hooks handle it)
        set -g allow-rename on
        set -g automatic-rename off
      '';
    };

    home.shellAliases.tx = "tmux new-session -A -s $(basename $PWD | tr . _)";

    programs.zsh.initExtra = ''
      # tmux automatic window renaming
      if [[ -n $TMUX ]]; then
        function current_dir() {
          local current_dir=$PWD
          if [[ $current_dir == $HOME ]]; then
            current_dir="~"
          else
            current_dir=''${current_dir##*/}
          fi
          echo $current_dir
        }

        function change_window_title() {
          local title=$1
          command tmux rename-window "$title" 2>/dev/null
        }

        function set_window_to_working_dir() {
          local title=$(current_dir)
          change_window_title $title
        }

        function set_window_to_command_line() {
          setopt localoptions extended_glob
          local cmd=''${1[(wr)^(*=*|sudo|ssh|mosh|-*)]:t}
          [[ -z "$cmd" ]] && return
          change_window_title $cmd
        }

        autoload -Uz add-zsh-hook
        add-zsh-hook precmd set_window_to_working_dir
        add-zsh-hook preexec set_window_to_command_line
      fi
    '';
  };
}

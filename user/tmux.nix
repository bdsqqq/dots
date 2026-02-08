{ lib, hostSystem ? null, ... }:
let
  isDarwin = lib.hasInfix "darwin" hostSystem;
  copyCommand = if isDarwin then "pbcopy" else "wl-copy";
in
{
  home-manager.users.bdsqqq = { pkgs, config, lib, ... }: 
  let
    spawnAssets = ../user/agents/skills/spawn/assets;
    randomNameScript = pkgs.writeShellScriptBin "tmux-random-name" ''
      FIRST=$(${pkgs.coreutils}/bin/shuf -n 1 "${spawnAssets}/firstnames.txt")
      LAST1=$(${pkgs.coreutils}/bin/shuf -n 1 "${spawnAssets}/lastnames_1.txt")
      LAST2=$(${pkgs.coreutils}/bin/shuf -n 1 "${spawnAssets}/lastnames_2.txt")
      echo "''${FIRST}_''${LAST1}''${LAST2}"
    '';
  in {
    programs.tmux = {
      enable = true;
      package = pkgs.tmux;
      
      prefix = "C-Space";
      terminal = "tmux-256color";
      shell = lib.getExe config.my.defaultShell;
      mouse = true;
      escapeTime = 0;
      baseIndex = 1;
      historyLimit = 50000;
      
      plugins = with pkgs.tmuxPlugins; [
        sensible
        yank
        vim-tmux-navigator
        {
          plugin = resurrect;
          extraConfig = ''
            set -g @resurrect-strategy-nvim 'session'
            set -g @resurrect-capture-pane-contents 'on'
            resurrect_dir="$HOME/.tmux/resurrect"
            set -g @resurrect-dir $resurrect_dir
            # nix store paths break resurrect's process matching on restore.
            # strip /nix/store/.../bin/ prefixes so saved entries use bare
            # command names (e.g. "nvim" not "/nix/store/abc-neovim/bin/nvim").
            # also strips --cmd ...-vim-pack-dir injected by nixvim's wrapper.
            # ref: https://discourse.nixos.org/t/30819
            # rewrite amp's node invocation to bare `amp` so resurrect
            # can restore sessions with `amp t c <thread-id>`.
            set -g @resurrect-processes '"~amp->amp"'
            set -g @resurrect-hook-post-save-all '${pkgs.gnused}/bin/sed -i "s| --cmd .*-vim-pack-dir||g; s|/nix/store/.*/bin/||g; s|\tnode\t:node --no-warnings [^\t]*@sourcegraph/amp/dist/main.js|\tamp\t:amp|g" $(readlink -f $resurrect_dir/last)'
          '';
        }
        {
          plugin = continuum;
          extraConfig = ''
            set -g @continuum-restore 'on'
            set -g @continuum-save-interval '15'
          '';
        }
      ];
      
      extraConfig = ''
        # override sensible's broken default-command (it uses $SHELL from build env)
        set -g default-command "${lib.getExe config.my.defaultShell}"
        
        # pane numbering consistent with window base-index
        set -g pane-base-index 1
        
        # let tmux set outer terminal title (visible in app switcher)
        set -g set-titles on
        set -g set-titles-string '#S: #W'
        
        # theme colors matching zellij (transparent bg)
        set -g status-style "bg=default,fg=#c2c2c2"
        set -g pane-border-style "fg=#374151"
        set -g pane-active-border-style "fg=#6b7280"
        set -g message-style "bg=default,fg=#c2c2c2"
        set -g message-command-style "bg=default,fg=#c2c2c2"
        
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
        
        # auto-renumber windows when one is closed (browser-like)
        set -g renumber-windows on
        
        # prefix + 1-9: browser-like tab switching (clamped to window count)
        bind 1 select-window -t :1
        bind 2 run-shell 'n=2; c=$(tmux list-windows | wc -l | tr -d " "); [ $n -gt $c ] && n=$c; tmux select-window -t :$n'
        bind 3 run-shell 'n=3; c=$(tmux list-windows | wc -l | tr -d " "); [ $n -gt $c ] && n=$c; tmux select-window -t :$n'
        bind 4 run-shell 'n=4; c=$(tmux list-windows | wc -l | tr -d " "); [ $n -gt $c ] && n=$c; tmux select-window -t :$n'
        bind 5 run-shell 'n=5; c=$(tmux list-windows | wc -l | tr -d " "); [ $n -gt $c ] && n=$c; tmux select-window -t :$n'
        bind 6 run-shell 'n=6; c=$(tmux list-windows | wc -l | tr -d " "); [ $n -gt $c ] && n=$c; tmux select-window -t :$n'
        bind 7 run-shell 'n=7; c=$(tmux list-windows | wc -l | tr -d " "); [ $n -gt $c ] && n=$c; tmux select-window -t :$n'
        bind 8 run-shell 'n=8; c=$(tmux list-windows | wc -l | tr -d " "); [ $n -gt $c ] && n=$c; tmux select-window -t :$n'
        bind 9 run-shell 'n=9; c=$(tmux list-windows | wc -l | tr -d " "); [ $n -gt $c ] && n=$c; tmux select-window -t :$n'
        
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
        
        # prefix + r: rename window (sets @custom_name to prevent auto-rename)
        bind r command-prompt -I "#W" "rename-window '%%'; set-option -w @custom_name '%%'"
        
        # prefix + C-r: clear custom name (re-enable auto-rename)
        bind C-r set-option -wu @custom_name
        
        # prefix + Ctrl+Space or Esc: cancel (send-prefix for double tap)
        bind C-Space send-prefix
        bind Escape copy-mode
        
        # automatic window renaming (let zsh hooks handle it)
        set -g allow-rename on
        set -g automatic-rename off
        
        # extended keys for shift+enter, ctrl+shift combos etc
        set -g extended-keys on
        set -g extended-keys-format csi-u
        
        # modern terminal features for ghostty
        # consolidated: all features ghostty supports in one entry
        set -as terminal-features ',ghostty:RGB,extkeys,clipboard,hyperlinks,focus,sync,strikethrough,usstyle,overline,sixel'
        
        # terminal overrides for modern terminals (ghostty, termius/xterm-256color)
        # Ss/Se: cursor shape, Smulx: undercurl, Setulc: underline color, RGB: truecolor
        set -ga terminal-overrides ',xterm*:Ss=\E[%p1%d q:Se=\E[ q:Smulx=\E[4::%p1%dm:Setulc=\E[58::2::%p1%{65536}%/%d::%p1%{256}%/%{255}%&%d::%p1%{255}%&%d%;m:RGB'
        set -ga terminal-overrides ',ghostty*:Ss=\E[%p1%d q:Se=\E[ q:Smulx=\E[4::%p1%dm:Setulc=\E[58::2::%p1%{65536}%/%d::%p1%{256}%/%{255}%&%d::%p1%{255}%&%d%;m:RGB'
        
        # passthrough for image protocols, sixel, etc
        set -g allow-passthrough on
        
        # osc52 clipboard (bidirectional with system clipboard)
        set -g set-clipboard on

        # sesh: fuzzy session manager backed by zoxide + fzf (prefix + T)
        # successor to t-smart-tmux-session-manager, rewritten in go.
        # pairs with zoxide — cd history becomes session candidates.
        # detach-on-destroy keeps you in tmux when closing a session
        # instead of dropping to bare shell.
        set -g detach-on-destroy off
        bind-key "T" run-shell "sesh connect \"$(
          sesh list --icons | fzf-tmux -p 80%,70% \
            --no-sort --ansi --border-label ' sesh ' --prompt '> ' \
            --header '  ^a all ^t tmux ^g configs ^x zoxide ^d tmux kill ^f find' \
            --bind 'tab:down,btab:up' \
            --bind 'ctrl-a:change-prompt(> )+reload(sesh list --icons)' \
            --bind 'ctrl-t:change-prompt(tmux> )+reload(sesh list -t --icons)' \
            --bind 'ctrl-g:change-prompt(cfg> )+reload(sesh list -c --icons)' \
            --bind 'ctrl-x:change-prompt(zox> )+reload(sesh list -z --icons)' \
            --bind 'ctrl-f:change-prompt(find> )+reload(fd -H -d 2 -t d -E .Trash . ~)' \
            --bind 'ctrl-d:execute(tmux kill-session -t {2..})+change-prompt(> )+reload(sesh list --icons)' \
            --preview-window 'right:55%' \
            --preview 'sesh preview {}'
        )\""
        bind -N "last-session (via sesh)" L run-shell "sesh last"
      '';
    };

    home.shellAliases.tx = "tmux new-session -A -s $(basename $PWD | tr . _)";
    
    home.packages = [ randomNameScript pkgs.sesh pkgs.fzf ];

    programs.zsh.initContent = ''
      # tmux automatic window renaming
      if [[ -n $TMUX ]]; then
        typeset -g TMUX_PANE_CUSTOM_NAME=""
        
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
          # don't overwrite custom names (e.g., for amp agents or manual renames)
          [[ -n "$TMUX_PANE_CUSTOM_NAME" ]] && return
          [[ -n "$(command tmux show-options -wqv @custom_name 2>/dev/null)" ]] && return
          local title=$(current_dir)
          change_window_title $title
        }

        function set_window_to_command_line() {
          setopt localoptions extended_glob
          # extract command name, handling env vars and sudo/ssh prefixes
          local words=(''${(z)1})
          local cmd=""
          for w in "''${words[@]}"; do
            # skip env assignments (FOO=bar) and common wrappers
            [[ "$w" == *=* || "$w" == sudo || "$w" == ssh || "$w" == mosh ]] && continue
            # skip flags
            [[ "$w" == -* ]] && continue
            cmd="''${w:t}"
            break
          done
          [[ -z "$cmd" ]] && return
          
          # amp gets a random human name, preserved across the session
          if [[ "$cmd" == "amp" ]]; then
            local current_name=$(command tmux display-message -p '#W')
            local current_dir_name=$(current_dir)
            # only assign new name if window is unnamed or has folder/amp name
            if [[ -z "$TMUX_PANE_CUSTOM_NAME" && ("$current_name" == "$current_dir_name" || "$current_name" == "amp") ]]; then
              TMUX_PANE_CUSTOM_NAME=$(tmux-random-name 2>/dev/null || echo "agent_$RANDOM")
            fi
            change_window_title "$TMUX_PANE_CUSTOM_NAME"
            return
          fi
          
          change_window_title $cmd
        }

        autoload -Uz add-zsh-hook
        add-zsh-hook precmd set_window_to_working_dir
        add-zsh-hook preexec set_window_to_command_line
      fi

      # ctrl+s: fuzzy session picker via sesh (works inside and outside tmux)
      function _sesh_connect() {
        local selected
        selected=$(sesh list --icons | fzf \
          --no-sort --ansi --border-label ' sesh ' --prompt '> ' \
          --header '  ^a all ^t tmux ^g configs ^x zoxide ^f find' \
          --bind 'tab:down,btab:up' \
          --bind 'ctrl-a:change-prompt(> )+reload(sesh list --icons)' \
          --bind 'ctrl-t:change-prompt(tmux> )+reload(sesh list -t --icons)' \
          --bind 'ctrl-g:change-prompt(cfg> )+reload(sesh list -c --icons)' \
          --bind 'ctrl-x:change-prompt(zox> )+reload(sesh list -z --icons)' \
          --bind 'ctrl-f:change-prompt(find> )+reload(fd -H -d 2 -t d -E .Trash . ~)' \
          --preview-window 'right:55%' \
          --preview 'sesh preview {}')
        [[ -z "$selected" ]] && { zle reset-prompt; return; }
        sesh connect "$selected"
        zle reset-prompt
      }
      zle -N _sesh_connect
      bindkey '^s' _sesh_connect
    '';
  };
}

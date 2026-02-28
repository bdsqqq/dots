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

    seshConnectScript = pkgs.writeShellScript "tmux-sesh-connect" ''
      selected="$(
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
      )"
      [ -n "$selected" ] || exit 0
      sesh connect "$selected"
    '';

    # --- keybind system ---
    # single source of truth: actions define what, bindings define where.
    # command-alias lets both bind-key and display-menu reference a
    # short token instead of quoting raw tmux commands everywhere.

    # escape single quotes for tmux command-alias values
    tq = s: builtins.replaceStrings ["'"] ["'\\''"] s;

    keySymbols = {
      "Tab" = "⇥";
      "BTab" = "⇧⇥";
      "C-r" = "⌃r";
      "C-Space" = "⌃␣";
      "Escape" = "⎋";
      "Space" = "␣";
      "Left" = "←";
      "Right" = "→";
      "Up" = "↑";
      "Down" = "↓";
    };
    displayKey = k: keySymbols.${k} or k;

    actions = {
      pane_left       = { desc = "pane ←";    cmd = "select-pane -L"; };
      pane_down       = { desc = "pane ↓";    cmd = "select-pane -D"; };
      pane_up         = { desc = "pane ↑";    cmd = "select-pane -U"; };
      pane_right      = { desc = "pane →";    cmd = "select-pane -R"; };
      win_next        = { desc = "next win";  cmd = "next-window"; };
      win_prev        = { desc = "prev win";  cmd = "previous-window"; };
      win_new         = { desc = "new win";   cmd = "new-window"; };
      win_close       = {
        desc = "close tab";
        # cascade: pane → window → detach
        cmd = ''if-shell '[ "$(tmux list-panes | wc -l)" -gt 1 ]' kill-pane 'if-shell "[ \"$(tmux list-windows | wc -l)\" -gt 1 ]" kill-window detach-client' '';
      };
      session_kill    = { desc = "kill sess";  cmd = "kill-session"; };
      rename_window   = { desc = "rename win"; cmd = ''command-prompt -I "#W" "rename-window '%%'; set-option -w @custom_name '%%'"''; };
      clear_custom_name = { desc = "clear name"; cmd = "set-option -wu @custom_name"; };
      split_h         = { desc = "split ─";   cmd = ''split-window -h -c "#{pane_current_path}"''; };
      split_v         = { desc = "split │";   cmd = ''split-window -v -c "#{pane_current_path}"''; };
      copy_mode       = { desc = "copy mode"; cmd = "copy-mode"; };
      send_prefix     = { desc = "send pfx";  cmd = "send-prefix"; };
      sesh_connect    = { desc = "sesh";      cmd = "run-shell ${seshConnectScript}"; };
      sesh_last       = { desc = "sesh last"; cmd = ''run-shell "sesh last"''; };
    } // builtins.listToAttrs (builtins.map (n: {
      name = "win_select_${toString n}";
      value = {
        desc = "win ${toString n}";
        cmd = if n == 1
          then "select-window -t :1"
          else ''run-shell 'n=${toString n}; c=$(tmux list-windows | wc -l | tr -d " "); [ $n -gt $c ] && n=$c; tmux select-window -t :$n' '';
      };
    }) (lib.range 1 9));

    bindings = [
      # --- panes (bind-only, hjkl is muscle memory) ---
      { action = "pane_left";  bind = { key = "h"; }; }
      { action = "pane_down";  bind = { key = "j"; }; }
      { action = "pane_up";    bind = { key = "k"; }; }
      { action = "pane_right"; bind = { key = "l"; }; }
      { action = "pane_left";  bind = { key = "Left"; }; }
      { action = "pane_down";  bind = { key = "Down"; }; }
      { action = "pane_up";    bind = { key = "Up"; }; }
      { action = "pane_right"; bind = { key = "Right"; }; }

      # --- windows (bind + menu) ---
      { action = "win_new";    bind = { key = "t"; };     menu = { cat = "Windows"; label = "new";        key = "t"; order = 1; }; }
      { action = "win_close";  bind = { key = "w"; };     menu = { cat = "Windows"; label = "close";      key = "w"; order = 2; }; }
      { action = "win_next";   bind = { key = "Tab"; };   menu = { cat = "Windows"; label = "next";       key = "Tab"; order = 3; }; }
      { action = "win_prev";   bind = { key = "BTab"; };  menu = { cat = "Windows"; label = "prev";       key = "BTab"; order = 4; }; }
      { action = "rename_window";     bind = { key = "r"; };     menu = { cat = "Windows"; label = "rename";     key = "r"; order = 5; }; }
      { action = "clear_custom_name"; bind = { key = "C-r"; };   menu = { cat = "Windows"; label = "clear name"; key = "C-r"; order = 6; }; }
      { action = "split_h";   bind = { key = "|"; };      menu = { cat = "Windows"; label = "split right"; key = "|"; order = 7; }; }
      { action = "split_v";   bind = { key = "-"; };      menu = { cat = "Windows"; label = "split down";  key = "-"; order = 8; }; }

      # --- sessions (bind + menu) ---
      { action = "sesh_connect"; bind = { key = "T"; };   menu = { cat = "Sessions"; label = "sesh";      key = "T"; order = 1; }; }
      { action = "session_kill"; bind = { key = "W"; };   menu = { cat = "Sessions"; label = "kill";      key = "W"; order = 2; }; }
      { action = "sesh_last";   bind = { key = "L"; };    menu = { cat = "Sessions"; label = "last";      key = "L"; order = 3; }; }

      # --- bind-only ---
      { action = "session_kill"; bind = { key = "q"; }; }
      { action = "send_prefix"; bind = { key = "C-Space"; }; }
      { action = "copy_mode";  bind = { key = "Escape"; }; }
    ]
    # window number selection: bind-only (collapsed in menu)
    ++ builtins.map (n: {
      action = "win_select_${toString n}";
      bind = { key = toString n; };
    }) (lib.range 1 9)
    ++ [{ action = "win_select_9"; bind = { key = "0"; }; }];

    # extra menu-only items (no action id — raw commands)
    menuExtras = [
      { cat = "Navigate"; label = "hjkl / ↑←↓→  panes"; key = ""; order = 1; cmd = ""; }
      { cat = "Windows"; label = "1-9  go to window"; key = ""; order = 10; cmd = ""; }
      { cat = "Windows"; label = "go to last"; key = "0"; order = 11; cmd = "wk-win_select_9"; }
      { cat = "Other"; label = "copy mode"; key = "Escape"; order = 1; cmd = "copy-mode"; }
      { cat = "Other"; label = "list keys"; key = "?"; order = 2; cmd = "list-keys"; }
    ];

    # --- generators ---

    actionNames = builtins.attrNames actions;

    # command-alias lines: set -g command-alias[N] 'wk-name=cmd'
    aliasLines = lib.imap1 (i: name:
      let a = actions.${name};
      in ''set -g command-alias[${toString (i + 200)}] '${tq "wk-${name}=${a.cmd}"}'  ''
    ) actionNames;

    # bind-key lines
    bindLines = builtins.concatMap (b:
      if b ? bind then
        [''bind-key ${b.bind.key} wk-${b.action}'']
      else []
    ) bindings;

    # group menu items by category
    menuBindings = builtins.filter (b: b ? menu) bindings;
    menuItems = (builtins.map (b: b.menu // { cmd = "wk-${b.action}"; }) menuBindings)
      ++ menuExtras;

    categories = [ "Windows" "Navigate" "Sessions" "Other" ];

    itemsForCat = cat:
      let
        matches = builtins.filter (m: m.cat == cat) menuItems;
      in builtins.sort (a: b: a.order < b.order) matches;

    colWidth = 26;

    symWidth = k:
      if builtins.elem k [ "BTab" "C-r" "C-Space" ] then 2
      else if k == "" then 0
      else 1;

    formatItem = item:
      let
        sym = displayKey item.key;
        sw = symWidth item.key;
        isInfo = item.cmd == "";
        rawLen = if isInfo
          then sw + (if sw > 0 then 1 else 0) + builtins.stringLength item.label
          else sw + 4 + builtins.stringLength item.label;
        padN = if colWidth > rawLen then colWidth - rawLen else 1;
        pad = builtins.concatStringsSep "" (lib.replicate padN " ");
      in if isInfo
        then "\\033[90m${sym}${if sw > 0 then " " else ""}${item.label}\\033[0m${pad}"
        else "\\033[1m${sym}\\033[0m ➜ ${item.label}${pad}";

    pairItems = items:
      let
        len = builtins.length items;
        indices = lib.range 0 (len - 1);
        evens = builtins.filter (i: lib.mod i 2 == 0) indices;
      in builtins.map (i:
        let
          left = formatItem (builtins.elemAt items i);
          right = if i + 1 < len then formatItem (builtins.elemAt items (i + 1)) else "";
        in "  ${left}${right}"
      ) evens;

    displayLines =
      let
        groups = builtins.map (cat:
          let items = itemsForCat cat;
          in if items == [] then [] else pairItems items
        ) categories;
        nonEmpty = builtins.filter (g: g != []) groups;
      in lib.concatMap (g: g ++ [""]) nonEmpty;

    dispatchItems = builtins.filter (item: item.cmd != "" && builtins.stringLength item.key == 1) menuItems;

    escapeCase = k:
      if builtins.elem k [ "|" "?" "*" "[" "]" "(" ")" ] then "'${k}'"
      else k;

    dispatchLines = builtins.map (item:
      "    ${escapeCase item.key}) tmux ${item.cmd} ;;"
    ) dispatchItems;

    hintScript = pkgs.writeShellScript "tmux-hints" ''
      printf '\033[2J\033[H'
      ${builtins.concatStringsSep "\n" (builtins.map (line: "printf '${line}\\n'") displayLines)}
      IFS= read -rsn1 key
      case "$key" in
      ${builtins.concatStringsSep "\n" dispatchLines}
      esac
    '';

    popupWidth = colWidth * 2 + 6;
    popupHeight = builtins.length displayLines + 3;

    generatedBlock = builtins.concatStringsSep "\n" (
      [ "" "# --- generated keybind system ---" ]
      ++ aliasLines
      ++ [ "" "# binds" ]
      ++ bindLines
      ++ [ "bind-key Space display-popup -E -x R -y 1 -w ${toString popupWidth} -h ${toString popupHeight} ${hintScript}" ]
    );

  in {
    programs.tmux = {
      enable = true;
      package = pkgs.tmux;
      
      prefix = "C-Space";
      terminal = "xterm-256color";
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
        
        # auto-renumber windows when one is closed (browser-like)
        set -g renumber-windows on
        
        # automatic window renaming (let zsh hooks handle it)
        set -g allow-rename on
        set -g automatic-rename off
        
        # --- extended keys ---
        #
        # "always" makes tmux send CSI u to inner apps unconditionally.
        # this alone does NOT fix ctrl+shift combos — it only sets mode 1
        # (MODE_KEYS_EXTENDED) which still sends ctrl+letter as legacy C0.
        # mode 2 requires the inner app to request CSI > 4;2m, but pi uses
        # kitty keyboard protocol which tmux doesn't understand.
        #
        # the actual fix for ctrl+shift is a ghostty text: keybind that
        # writes the CSI u bytes directly. see ghostty.nix.
        set -g extended-keys always
        set -g extended-keys-format csi-u
        
        # terminal features for ghostty
        #
        # pattern must match #{client_termname} — ghostty reports as
        # "xterm-ghostty", NOT "ghostty". use fnmatch-compatible pattern.
        #
        # features are colon-separated (one terminal). comma-separated
        # would create separate unassociated entries. use indexed set
        # instead of "set -as" to prevent duplication on config reload.
        #
        # extkeys tells tmux the outer terminal supports modifyOtherKeys.
        # tmux then sends CSI > 4;2m to ghostty at attach time. in practice
        # ghostty doesn't reliably enter modifyOtherKeys mode from this
        # (see ghostty.nix), but extkeys is still needed for tmux to accept
        # CSI u sequences arriving via the text: workaround.
        set -g terminal-features[3] 'xterm-ghostty:RGB:extkeys:clipboard:hyperlinks:focus:sync:strikethrough:usstyle:overline:sixel'
        
        # terminal overrides for modern terminals (ghostty, termius/xterm-256color)
        # Ss/Se: cursor shape, Smulx: undercurl, Setulc: underline color, RGB: truecolor
        set -ga terminal-overrides ',xterm*:Ss=\E[%p1%d q:Se=\E[ q:Smulx=\E[4::%p1%dm:Setulc=\E[58::2::%p1%{65536}%/%d::%p1%{256}%/%{255}%&%d::%p1%{255}%&%d%;m:RGB'
        set -ga terminal-overrides ',xterm-ghostty*:Ss=\E[%p1%d q:Se=\E[ q:Smulx=\E[4::%p1%dm:Setulc=\E[58::2::%p1%{65536}%/%d::%p1%{256}%/%{255}%&%d::%p1%{255}%&%d%;m:RGB'
        
        # passthrough for image protocols, sixel, etc
        set -g allow-passthrough all
        
        # osc52 clipboard (bidirectional with system clipboard)
        set -g set-clipboard on

        # sesh: detach-on-destroy keeps you in tmux when closing a session
        set -g detach-on-destroy off
      '' + generatedBlock;
    };

    home.shellAliases.tx = "tmux new-session -A -s \"$(basename \"$PWD\" | tr '. ' '_')\"";
    
    home.packages = [ randomNameScript pkgs.sesh pkgs.fzf ];

    programs.zsh.initContent = ''
      # tmux automatic window renaming
      if [[ -n $TMUX ]]; then
        typeset -g TMUX_PANE_CUSTOM_NAME=""
        
        function current_dir() {
          local current_dir="$PWD"
          if [[ "$current_dir" == "$HOME" ]]; then
            current_dir="~"
          else
            current_dir="''${current_dir##*/}"
          fi
          echo "$current_dir"
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
          change_window_title "$title"
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
          
          change_window_title "$cmd"
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

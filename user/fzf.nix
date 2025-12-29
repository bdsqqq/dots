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

    programs.zsh.initContent = ''
      # custom fzf file widget (ctrl+f)
      _fzf_files() {
        local selected=$(rg --files --hidden --follow | fzf --height=40% --layout=reverse --border)
        LBUFFER="''${LBUFFER}''${selected}"
        zle reset-prompt
      }
      zle -N _fzf_files
      bindkey '^F' _fzf_files

      # custom fzf history widget (ctrl+r) with logfmt metadata display
      _fzf_history() {
        fc -R  # reload history from file to ensure we have latest
        local current_user="''${USER}"
        local current_host="''${HOST}"
        local selected=$(fc -rl 1 | ${pkgs.gawk}/bin/gawk -v cur_user="$current_user" -v cur_host="$current_host" '
          {
            # fc -rl output format: "  757  : 1767045258:0;command  # logfmt"
            # or old entries without extended history: "  757  command"
            
            # skip empty lines
            if ($0 == "") next
            
            # find the semicolon that separates timestamp from command
            rest = substr($0, index($0, ":"))
            semi = index(rest, ";")
            
            if (semi == 0) {
              # no semicolon - old format without timestamp
              # extract command after line number
              match($0, /^[[:space:]]*[0-9]+[[:space:]]+/)
              cmd = substr($0, RLENGTH + 1)
              timestamp = 0
              tag = ""
            } else {
              # extended history format
              # extract timestamp (after first colon, before second colon)
              ts_part = substr(rest, 2)  # skip leading :
              colon2 = index(ts_part, ":")
              if (colon2 > 0) {
                timestamp = substr(ts_part, 1, colon2 - 1)
              } else {
                timestamp = 0
              }
              
              # extract command (after semicolon)
              full_cmd = substr(rest, semi + 1)
              
              # split command from logfmt tag
              tag_idx = index(full_cmd, "  # ")
              if (tag_idx > 0) {
                cmd = substr(full_cmd, 1, tag_idx - 1)
                tag = substr(full_cmd, tag_idx + 4)
              } else {
                cmd = full_cmd
                tag = ""
              }
            }
            
            # parse logfmt fields
            user = ""; host = ""; dir = ""; agent = ""; thread = ""
            n = split(tag, pairs, " ")
            for (i = 1; i <= n; i++) {
              eq = index(pairs[i], "=")
              if (eq > 0) {
                key = substr(pairs[i], 1, eq - 1)
                val = substr(pairs[i], eq + 1)
                # strip quotes if present
                gsub(/^"/, "", val); gsub(/"$/, "", val)
                if (key == "user") user = val
                else if (key == "host") host = val
                else if (key == "dir") dir = val
                else if (key == "agent") agent = val
                else if (key == "thread") thread = val
              }
            }
            
            # format timestamp
            if (timestamp > 0) {
              datetime = strftime("%Y-%m-%d %H:%M", timestamp)
            } else {
              datetime = "????-??-?? ??:??"
            }
            
            # build context display - only show if different from current
            ctx = ""
            if (agent != "") {
              # truncate long thread IDs: first4...last4
              if (length(thread) > 8) {
                thread = substr(thread, 1, 4) "..." substr(thread, length(thread) - 3)
              }
              ctx = agent ":" thread
            }
            if (host != "" && host != cur_host) {
              if (ctx != "") ctx = ctx "@" host
              else ctx = host
            }
            
            # output with colors
            if (ctx != "") {
              printf "\033[90m%s\033[0m \033[33m[%s]\033[0m %s\n", datetime, ctx, cmd
            } else {
              printf "\033[90m%s\033[0m %s\n", datetime, cmd
            }
          }
        ' | fzf --ansi --height=40% --layout=reverse --border --no-sort --tac)
        
        if [[ -n "$selected" ]]; then
          # strip ansi codes, datetime, and optional tag to get clean command
          local cmd=$(echo "$selected" | sed -E 's/\x1b\[[0-9;]*m//g; s/^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2} //; s/^\[[^]]+\] //')
          LBUFFER="$cmd"
        fi
        zle reset-prompt
      }
      zle -N _fzf_history
      bindkey '^R' _fzf_history
    '';
  };
}

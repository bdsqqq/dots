# Custom fzf history widget with logfmt metadata display
# Requires: gawk, fzf
# Expected env: HISTFILE, USER, HOST
# Expected substitution: @gawk@ -> path to gawk, @awkScript@ -> path to history-format.awk

_fzf_history() {
    fc -R  # reload history from file to ensure we have latest
    
    local current_user="${USER}"
    local current_host="${HOST}"
    
    local selected=$(fc -liD 1 | @gawk@ \
        -v cur_user="$current_user" \
        -v cur_host="$current_host" \
        -f @awkScript@ \
        | fzf --ansi --height=40% --layout=reverse --border --no-sort --tac)
    
    if [[ -n "$selected" ]]; then
        # strip ansi codes, datetime, optional [context] tag, and trailing logfmt tag
        local cmd=$(echo "$selected" | sed -E 's/\x1b\[[0-9;]*m//g; s/^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2} //; s/^\[[^]]+\] //; s/  # [a-z]+=.*$//')
        LBUFFER="$cmd"
    fi
    zle reset-prompt
}

zle -N _fzf_history
bindkey '^R' _fzf_history

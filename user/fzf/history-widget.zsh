# Custom fzf history widget with logfmt metadata display
# Requires: gawk, fzf
# Expected env: HISTFILE, USER, HOST
# Expected substitution: @gawk@ -> path to gawk, @awkScript@ -> path to history-format.awk

_fzf_history() {
    fc -R  # reload history from file to ensure we have latest
    
    local current_user="${USER}"
    local current_host="${HOST}"
    local today=$(date +%Y-%m-%d)
    
    local selected=$(fc -liD 1 | @gawk@ \
        -v cur_user="$current_user" \
        -v cur_host="$current_host" \
        -v today="$today" \
        -f @awkScript@ \
        | @tac@ \
        | fzf --ansi --height=40% --layout=reverse --border --no-sort --delimiter='\t' --with-nth=2 -q "$LBUFFER")
    
    if [[ -n "$selected" ]]; then
        # first tab-delimited field is the raw command
        LBUFFER="${selected%%	*}"
    fi
    zle reset-prompt
}

zle -N _fzf_history
bindkey '^R' _fzf_history

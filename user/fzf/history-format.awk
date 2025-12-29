# Parse fc -rl output and format for fzf display with logfmt metadata
# Input format: "  757  : 1767045258:0;command  # user=x host=y dir=z"
# Output format: "2024-12-29 21:15 [context] command" with ANSI colors
#
# Variables passed in:
#   cur_user - current username
#   cur_host - current hostname

{
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
    
    # output with colors (gray datetime, yellow context)
    if (ctx != "") {
        printf "\033[90m%s\033[0m \033[33m[%s]\033[0m %s\n", datetime, ctx, cmd
    } else {
        printf "\033[90m%s\033[0m %s\n", datetime, cmd
    }
}

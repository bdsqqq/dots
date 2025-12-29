# Parse fc -liD output and format for fzf display with logfmt metadata
# Input format: "  757  2024-12-29 21:15  0:00  command  # user=x host=y dir=z"
# Output format: "2024-12-29 21:15 [context] command" with ANSI colors
#
# Variables passed in:
#   cur_user - current username
#   cur_host - current hostname

{
    # skip empty lines
    if ($0 == "") next
    
    # fc -liD format: "  NUM  YYYY-MM-DD HH:MM  ELAPSED  command"
    # $1 = line number, $2 = date, $3 = time, $4 = elapsed, rest = command
    
    datetime = $2 " " $3
    
    # find where command starts (after 4th field)
    # match: leading space + number + space + date + space + time + space + elapsed + space
    match($0, /^[[:space:]]*[0-9]+[[:space:]]+[0-9-]+[[:space:]]+[0-9:]+[[:space:]]+[0-9:]+[[:space:]]+/)
    if (RSTART > 0) {
        full_cmd = substr($0, RSTART + RLENGTH)
    } else {
        # fallback: just use everything after elapsed field
        full_cmd = ""
        for (i = 5; i <= NF; i++) {
            full_cmd = full_cmd (i > 5 ? " " : "") $i
        }
    }
    
    # split command from logfmt tag
    tag_idx = index(full_cmd, "  # ")
    if (tag_idx > 0) {
        cmd = substr(full_cmd, 1, tag_idx - 1)
        tag = substr(full_cmd, tag_idx + 4)
    } else {
        cmd = full_cmd
        tag = ""
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

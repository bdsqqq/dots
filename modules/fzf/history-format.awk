# Parse fc -liD output and format for fzf display with logfmt metadata
# Input format: "  757  2024-12-29 21:15  0:00  command  # user=x host=y dir=z"
# Output format: "command [who@where] HH:MM" with ANSI colors
#
# Variables passed in:
#   cur_user - current username
#   cur_host - current hostname
#   today    - today's date as YYYY-MM-DD

{
    # skip empty lines
    if ($0 == "") next
    
    # fc -liD format: "  NUM  YYYY-MM-DD HH:MM  ELAPSED  command"
    # $1 = line number, $2 = date, $3 = time, $4 = elapsed, rest = command
    
    date = $2
    time = $3
    
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
    
    # build context: who (agent or host if different)
    who = ""
    if (agent != "") {
        # truncate long thread IDs: first4...last4
        if (length(thread) > 8) {
            thread = substr(thread, 1, 4) "..." substr(thread, length(thread) - 3)
        }
        who = agent ":" thread
    }
    if (host != "" && host != cur_host) {
        if (who != "") who = who "@" host
        else who = host
    }
    
    # build when: only show time if today, else date+time
    if (date == today) {
        when = time
    } else {
        when = date " " time
    }
    
    # output: raw_cmd \t formatted_display
    # fzf uses --with-nth=2 to show only formatted, we extract field 1 after selection
    if (who != "") {
        printf "%s\t%s \033[90m[%s] %s\033[0m\n", cmd, cmd, who, when
    } else {
        printf "%s\t%s \033[90m%s\033[0m\n", cmd, cmd, when
    }
}

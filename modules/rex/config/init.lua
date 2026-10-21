-- Rex matches unshifted keys; these are cmd+| and cmd+_ on a US layout.
rex.bind("cmd+shift+[Backslash]", "pane.split", { direction = "right" })
rex.bind("cmd+shift+-", "pane.split", { direction = "down" })

rex.bind("cmd+k", "client.palette.toggle")
rex.bind("cmd+9", "client.tab.goto", { index = -1 })

rex.bind("alt+cmd+left", "pane.focus.left")
rex.bind("alt+cmd+down", "pane.focus.down")
rex.bind("alt+cmd+up", "pane.focus.up")
rex.bind("alt+cmd+right", "pane.focus.right")

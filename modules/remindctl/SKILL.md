---
name: remindctl
description: "Read or change Apple Reminders lists and reminders on macOS using remindctl. Use for explicitly requested Reminders tasks; not calendar events, agent scheduler jobs, or generic project todos."
---

# apple reminders

requires macOS 14+ and full Reminders access for the terminal running the command.
start with `remindctl --help` and `remindctl status --json`. if access is missing,
stop and explain the host/terminal permission requirement. `authorize` triggers a
permission prompt: only run it when the user requests setup. SSH uses the remote
Mac's permission, not the caller's.

for reads, use `remindctl today --json`, `remindctl all --json`, or
`remindctl list --json`. inspect subcommand help before choosing version-specific
flags. target a unique stable reminder ID from current output; numeric indexes
can change. resolve duplicate list names before writing.

for an authorized addition, use `remindctl add "title" --list "list" --due
"YYYY-MM-DD HH:mm"`. resolve the user's timezone and date first; a date without
a time is an all-day reminder. edit/complete only the requested IDs. deletion
needs explicit authorization for the exact reminders/lists; never use `--force`
as a workaround for uncertainty. reread the affected item/list after mutation.
if a save reports an error, inspect current state before retrying to avoid duplicates.

EventKit is the data backend, not a repository config file. do not fabricate
settings, touch the Reminders database, or claim tags, attachments, smart lists,
or Apple's private urgent toggle are supported by this CLI. a successful local
read does not prove notification delivery or iCloud convergence.

source: [upstream commands and EventKit limits](https://github.com/openclaw/remindctl/blob/main/README.md).

# reminders native readiness

macOS only. `my.remindctl.integration` defaults to disabled. enabled mode requires
`account` (a human account/store binding) and an exact stable `listId` belonging to
the intended EventKit account. EventKit/remindctl cannot authenticate or select an
Apple ID directly; an exact list id prevents silent default-list selection.
Linux keeps the empty module shape and receives no Homebrew dependency.

`remindctl-ready --local` runs `status --json` and requires `authorized: true` plus
`status: "full-access"`. missing/write-only/revoked TCC access fails; it never runs
`authorize` or requests consent. `remindctl-ready` then reads list summaries through
`list --json`, validates the summary fields and presence of the exact selected id.
it suppresses all private output/errors and bounds each subprocess to 15 seconds.
this verifies EventKit reads for this host/process; it cannot prove iCloud sync,
notification delivery, or Apple account authentication. the signed binary remains
Homebrew-owned (Apple Silicon /opt/homebrew, Intel /usr/local).

source contract inspected at upstream revision
[a671703439aba769ba71028aa940445478187aa6](https://github.com/steipete/remindctl/tree/a671703439aba769ba71028aa940445478187aa6):
[status](https://github.com/steipete/remindctl/blob/a671703439aba769ba71028aa940445478187aa6/Sources/remindctl/Commands/StatusCommand.swift),
[JSON fields](https://github.com/steipete/remindctl/blob/a671703439aba769ba71028aa940445478187aa6/Sources/remindctl/OutputFormatting.swift),
[authorization](https://github.com/steipete/remindctl/blob/a671703439aba769ba71028aa940445478187aa6/Sources/RemindCore/RemindersAuthorization.swift).
Homebrew is not pinned by this module; installed-version consent/read behavior
remains a deployment verification step.

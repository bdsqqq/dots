---
name: agent-desktop
description: "Read or operate native desktop apps through the agent-desktop accessibility CLI. Use when semantic app elements are useful or troubleshooting this CLI's macOS permissions; not for browser pages, ordinary file edits, or permission to open apps or switch desktops."
---

# native desktop accessibility

before the first operation, run `agent-desktop skills get desktop` and
`agent-desktop skills get platform` for version-matched command contracts.
these describe capabilities, not authority to request consent or affect other
apps. prefer shell/file operations when they satisfy the task.

## scope before observation

- all desktop UI work must stay on desktop 1; desktop 2 may be actively used.
  a display ID is NOT a macOS Space. `--app` and `--window-id` identify
  targets, not their Space. headless delivery is not a desktop-1 guarantee.
- verify the exact target is confined to desktop 1 without opening/focusing an
  app or changing Spaces. if this cannot be established with available evidence,
  stop and ask the user to arrange/confirm it. do not probe desktop 2.
- never fall back to `--headed`, app launch, focus-window, notification UI,
  permission guides, or global input just because a headless action failed.
  those require explicit authorization AND verified desktop-1 confinement.

## permission boundary

`agent-desktop permissions` is a non-prompting check. inspect nested
accessibility, screen_recording and automation states; `ok: true` means the
check ran, not that consent exists. do not run `--request` or `--guide`
without permission: the latter opens System Settings. never edit TCC.

the launching app may still be the permission owner. the module's unversioned
native path does not guarantee grants survive a binary or harness update.
missing Accessibility blocks tree operations; screenshot work additionally
requires Screen Recording. do not silently replace a denied screenshot with
a different capture tool.

## operate only within the confirmed target

take a scoped snapshot of the confirmed app/window; use full snapshot-qualified
refs, then observe again to verify the effect. stale or ambiguous refs require
a fresh snapshot, not guessed coordinates. inspect structured errors and retry
only when their disposition says it is safe. retain snapshots/screenshots
privately; avoid logging unrelated app content.

browser pages belong to the selected browser workflow. ordinary notes/config
edits belong to filesystem tools. a read request does not authorize app edits,
sending, publishing, or consent changes.

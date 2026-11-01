# agent-desktop

macos-only native accessibility CLI, imported explicitly by the three Mac hosts.
installation follows the live-manifest pattern: activation runs a frozen pnpm
install here; the Nix launcher executes the native binary and matching helper
from that same installation. no daemon, MCP server, credentials, or UI startup
is configured. the shared skill discovery link exposes CLI usage to agents.

`pnpm-workspace.yaml` uses a hoisted layout to avoid versioned executable paths.
the npm archive already includes both binaries, so installation scripts are
disabled and the launcher selects the pair directly. update with ordinary pnpm
commands here, then verify version/help and permissions in the intended harness.
manual catch-up (also the activation command):

```sh
pnpm install --dir modules/agent-desktop --frozen-lockfile --ignore-scripts
agent-desktop version
agent-desktop skills get desktop
agent-desktop skills get platform
agent-desktop permissions
```

the command becomes globally available after an approved host activation. before
that, tests can use the evaluated Nix launcher without activating anything.

## consent is still native

Accessibility (called Device Control and Data Access on macOS 27+) is required.
screenshots additionally need Screen Recording; some System Events operations
need Automation. grant only the required access manually in the actual launching
context. plain `permissions` does not prompt; `permissions --request` can prompt
and `permissions --guide` opens System Settings. neither runs during installation.

**this is not a proven fix for versioned T3 permission attribution.** the
unversioned native path removes one source of path churn, but upstream explicitly
documents consent for the launching app, and possibly the binary separately.
the 1.0.2 arm64 CLI and helper inspected with `codesign -dvv` both report
`Signature=adhoc` and `TeamIdentifier=not set`; there is no demonstrated stable
Developer ID identity across releases. neither a shell wrapper nor a stable
pathname proves TCC will attribute capture to it instead of the harness. tree
operations can avoid screenshots, but that does not repair screen-capture consent.

sources for the installed release:
[macOS guidance](https://github.com/vercel-labs/agent-desktop/blob/a47ed664e0db00d1d4df364eb3fe8a5599882f3c/skills/agent-desktop-macos/SKILL.md),
[permission implementation](https://github.com/vercel-labs/agent-desktop/blob/a47ed664e0db00d1d4df364eb3fe8a5599882f3c/crates/macos/src/system/permissions/mod.rs),
[npm package](https://www.npmjs.com/package/agent-desktop/v/1.0.2).
embedded `skills get` docs track the installed binary rather than upstream main.

## desktop boundary and verification

all UI work must remain on desktop 1. desktop 2 is actively used. a display,
app name, window ID, or headless mode does not establish Space confinement.
do not open/focus apps, switch Spaces, take screenshots, or exercise UI actions
until the target is verified on desktop 1. stop if that cannot be established.

safe checks are version, help, embedded docs and non-prompting permissions.
inspect nested permission states rather than the envelope's success flag.
runtime app observation, semantic actions, screenshots and grant persistence
across upgrades still need an approved desktop-1 test in the intended harness.
no TCC database edits, automated grants, custom signing, or host activation are
part of this module.

local contract tests: `node --test modules/agent-desktop/module.test.ts`.
skill fixtures are authored expectations, not executed model/UI evaluations.

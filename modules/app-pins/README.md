# app-pins

some apps update themselves, which normally makes them invisible to nix.
nix either fights the updater or loses track of the version. here the app
stays in charge of updating, and the repo records what it actually installed.
same contract as pnpm globals: nix kickstarts, updates happen outside the
store, and git carries the result to every other host.

this module holds only the machinery. each app is declared by the module
that owns it, in `app-pin.spec.json`, with its pin beside it in
`app-pin.json` (e.g. [`../rex/`](../rex), [`../claude/`](../claude)). two
kinds are pinned:

- **mac app bundles** (rex, helium, t3 code, tailscale).
- **record-only apps** (tailscale) set `"install": false`: the pin records
  what the updater accepted, and nothing installs it. tailscale's bundle is
  root-owned and carries a system extension, so how to install a pin of it is
  still open.
- **vendor CLIs** (claude, codex), installed in each vendor's own native
  layout, the one their install scripts and `claude update` / `codex update`
  maintain. T3 runs those updates; every host, mac or linux, records what it
  accepted and installs the pin.

## the contract

- **a pin is a floor, and it only moves up.** a mac records a build only if it
  is newer than the pin. activation installs the pin only where the app is
  missing or older, and never touches a newer or running app. every other
  property depends on this one: concurrent macs can't conflict into a
  downgrade, and a stale view of `main` can only cause redundant work.
- **a pin names one exact build.** it records that build's url and sha256,
  never the moving head of a channel, so any host can fetch the same bytes
  later.
- **the checkout is never involved.** agents publish from private clones of
  `main`, because a working tree may be dirty, on another branch, or
  mid-rebase. a bump is an ordinary commit, `bump <app> (auto-committed from
  <host>)`, signed if your git signs commits, so every published version shows
  which mac accepted it.
- **vendor CLIs are the same everywhere.** any host can bump a CLI pin, and
  every host installs it, so updating codex on a server moves the macs too.
  each pin names all three platforms' builds, resolved together, so a pin
  never exists for one platform only. nix turns off the CLIs' own update
  checks (`DISABLE_AUTOUPDATER`, `check_for_update_on_startup`) through
  machine policy files, so a version only moves when someone asks for it.
- **linux follows the mac** for app bundles with a linux side (rex's CLI, helium's
  AppImage), the linux pin tracks what a mac accepted instead of chasing
  upstream. it replaces a CI job that published every rex snapshot whether or
  not anyone had run it.

## decisions worth knowing before changing this

- **one clone per app, no lock.** launchd never runs two copies of one agent,
  so separate clones remove all shared git state. two attempts at locking a
  shared clone both had races.
- **unchanged runs skip the network, but only within a bounded window.** the
  mac pin is monotonic, so a lagging clone is harmless. linux follow-ups are not:
  another mac can publish a newer app whose linux pin still needs advancing.
  the window bounds how long one host can miss that.
- **expected failures have codes, not messages, in events.** exception text can
  hold paths or other private data, so it goes to stderr only. see
  [service-events](../service-events/README.md).
- `pins.ts` and `publish.ts` still accept their pre-`cli.ts` argv. this keeps
  agents and activations built before the change working. drop the shims once
  every mac has switched past it.

- **vendor layouts, not ours.** the installer writes exactly what the
  vendor's script would (`~/.local/share/claude/versions/<v>`,
  `~/.codex/packages/standalone/releases/<v>-<target>` plus `current`), so
  `claude update`, `codex update` and T3's provider detection keep working.
  an install that isn't the vendor's native one (a different link target, a
  regular file) is refused, never overwritten. a pinned codex is not on the
  latest channel, as with `install.sh --release`.
- **linux hosts push over https.** they have no trusted github host key, but
  git's credential helper already reads the host's `gh_token`. installs run
  from systemd user units, not activation, so a 200MB download never holds up
  a switch.

## adding an app

put `app-pin.spec.json` in the module that owns the app (create one if none
exists, as claude and codex did): the `BundleApp` or `VendorApp` fields from
`pins.ts` / `vendor.ts`, without `name` or `pin`. the module's directory is
the app's name, and its pin is `app-pin.json` beside the spec. `pins.ts` and
`default.nix` both discover these files.

moving an app's pin to another path is a migration: publishers running the
old code keep writing the old path until their checkout advances. pause them
(`launchctl bootout` / `systemctl --user stop`) across the move.

an app fits if its updater replaces the whole bundle on each update, which is
what makes watching `Info.plist` reliable. its feed must also let you look up
an exact build by version. Sparkle appcasts listing every build, GitHub
releases, and versioned download urls (`"kind": "url"`, for appcasts that
list only the newest build) all qualify.
an app that patches files in place, or whose vendor deletes old builds,
doesn't fit. a CLI fits if its vendor publishes per-version builds with
hashes for every pinned platform, and selects the running build with a link.

## limits

- rex's linux pin depends on its appcast notes naming the bundled CLI commit.
  if that line disappears, the mac pin keeps advancing but the linux pin
  silently stops.
- the tests use real bundles, zips, tarballs and git repositories in
  temporary directories. they don't cover a live Sparkle swap firing the
  watcher, a dmg mounting on another machine, or pushing from inside launchd
  or a systemd user unit.
- codex on linux prunes releases nothing runs from, because pinned hosts may
  never run the vendor installer, which normally prunes. on macs the vendor
  installer still prunes.

usage: `node modules/app-pins/cli.ts` prints it. checks:
`node --test modules/app-pins/*.test.ts` and
`(cd modules/pi && pnpm exec tsc -p ../app-pins/tsconfig.json)`.

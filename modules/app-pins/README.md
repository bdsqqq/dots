# app-pins

some mac apps update themselves, which normally makes them invisible to nix.
nix either fights the updater or loses track of the version. here the app
stays in charge of updating, and the repo records what it actually installed.
same contract as pnpm globals: nix kickstarts, updates happen outside the
store, and git carries the result to every other host.

apps and their feeds are listed in [`apps.json`](apps.json); each app's pin
lives beside the module that consumes it.

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
- **linux follows the mac.** for apps with a linux side (rex's CLI, helium's
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

## adding an app

an app fits if its updater replaces the whole bundle on each update, which is
what makes watching `Info.plist` reliable. its feed must also let you look up
an exact build by version. Sparkle appcasts and GitHub releases both qualify.
an app that patches files in place, or whose vendor deletes old builds,
doesn't fit.

## limits

- rex's linux pin depends on its appcast notes naming the bundled CLI commit.
  if that line disappears, the mac pin keeps advancing but the linux pin
  silently stops.
- the tests use real bundles, zips and git repositories in temporary
  directories. they don't cover a live Sparkle swap firing the watcher, a dmg
  mounting on another machine, or pushing from inside launchd itself.

usage: `node modules/app-pins/cli.ts` prints it. checks:
`node --test modules/app-pins/*.test.ts` and
`(cd modules/pi && pnpm exec tsc -p ../app-pins/tsconfig.json)`.

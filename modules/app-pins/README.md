# app-pins

self-updating mac apps keep their own updaters. this module makes those
updates reproducible: the mac that ran an update records it into a tracked pin,
and the next activation anywhere converges on it. same contract as pnpm
globals: nix kickstarts, updates happen outside the store, and the working tree
is the source of truth.

| app | updater | pin | also pins |
|---|---|---|---|
| Rex.app | Sparkle (signed appcast) | [`../rex/app-pin.json`](../rex/app-pin.json) | linux CLI [`../rex/release.json`](../rex/release.json), via the commit bundled in the app |
| Helium | Sparkle | [`../helium/app-pin.json`](../helium/app-pin.json) | linux AppImages, read by [`../helium/default.nix`](../helium/default.nix) |
| T3 Code (Nightly) | electron-updater (GitHub nightly) | [`../t3-code/app-pin.json`](../t3-code/app-pin.json) | — |

## operations

three operations, one command line ([`cli.ts`](cli.ts)):

| operation | where | does |
|---|---|---|
| `record` | [`pins.ts`](pins.ts) | pin the installed build into a store (working tree or overlay). never downgrades |
| `install` | [`pins.ts`](pins.ts) | install the pinned build if the app is missing or older; never over a newer or running app |
| `publish` | [`publish.ts`](publish.ts) | `record` against origin/main, commit, push, without touching the checkout |

each takes an explicit app (from [`apps.json`](apps.json)), store or options, and
dependencies (`Deps`: shell, feed, download). expected failures throw
`AppPinError` with a stable `code`; the command line maps those into events and
exit status. `pins.ts` and `publish.ts` still accept their old argv and forward to
`cli.ts`, so agents activated before this change keep working until each mac
switches.

## publish (after a self-update)

a launchd agent per app (`app-pin-<name>`) watches the bundle's
`Contents/Info.plist`; Sparkle and electron-updater replace the whole bundle, so
every update touches it. it also runs at load.

1. **local first.** each app has its own private blobless clone,
   `~/.local/state/app-pins/<app>.git`. if the main it last fetched already pins
   this build and its linux follow-ups, the run ends there: about 0.13 s, no
   network. a clone that lags main is safe: pins only move up, so an old pin can
   only cause an extra fetch, never a skipped bump.
2. otherwise it fetches main and runs `record` against an in-memory overlay of
   that tree. the checkout is never read or written, so a dirty tree, another
   branch, or a rebase in progress doesn't matter. the feed entry is the one for
   exactly the installed build, with its url and sha256. for rex, the linux CLI
   pin advances to the bundled commit if newer, and the CLI version is kept in
   the pin so later runs can settle offline. helium's linux pin is retried each run
   until its release exists.
3. changed pin files are committed on top of main, signed when `commit.gpgsign` is
   on, as `bump <app> (auto-committed from <host>)` with what changed in the body,
   and pushed without force. a rejected push refetches and recomputes; losing a race
   to a newer pin from another mac becomes a no-op.

launchd never runs two copies of one agent, and agents don't share clones, so
there is no lock.

## events

one event per app per run in `~/Library/Logs/app-pins.log`, through
[`service-events`](../service-events/README.md): `app.record`, `app.install`, or
`app.publish`, with the app (`action`), outcome (`reasonCode`), `fromVersion` /
`toVersion`, `changed`, and for publish `networkSkipped`, `attempt`, `fetchMs`,
`feedMs`, `pushMs`, and the pushed `revision`. failures carry `errorCode` and,
for expected ones, the `AppPinError` code as `reasonCode`; exception text goes to
stderr, never into the event.

## install (activation)

`home.activation.installPinnedApps` runs `cli.ts install` for the host's
`my.appPins.apps`. a missing or older app gets the pinned artifact: download,
verify sha256, check the bundle id and build inside it, then swap it into
`/Applications`. a newer app (it self-updated past the pin) and a running app
are left alone. failures warn without blocking activation.

## add an app

add an entry to [`apps.json`](apps.json) (bundle path/id, pin path, `compare`
= `build` for Sparkle `CFBundleVersion` or `short` for the version string, and
its feed), then list it in a host's `my.appPins.apps`. record once on a mac
that has it installed to create the pin.

## operate

```bash
node modules/app-pins/cli.ts publish --remote git@github.com:bdsqqq/dots.git --host "$(scutil --get LocalHostName)" rex
node modules/app-pins/cli.ts record --repo "$PWD"          # working tree only; all apps, or name them
node modules/app-pins/cli.ts install --repo "$PWD" helium
jq -c '{t: .timestamp, op: .operation, c: .context}' ~/Library/Logs/app-pins.log | tail
launchctl list | grep app-pin
```

## checks

```bash
node --test modules/app-pins/pins.test.ts modules/app-pins/publish.test.ts modules/app-pins/cli.test.ts
(cd modules/pi && pnpm exec tsc -p ../app-pins/tsconfig.json)
```

tests build real app bundles and zip artifacts in temporary directories, and
publish into local bare repositories; they do not touch `/Applications` or GitHub. they don't prove a live Sparkle swap fires the
watcher, or that a dmg mounts on another machine.

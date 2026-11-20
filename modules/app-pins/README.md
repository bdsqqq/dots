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

## record and publish (after a self-update)

a launchd agent per app (`app-pin-<name>`) watches the bundle's
`Contents/Info.plist`; Sparkle and electron-updater replace the whole bundle,
so every update touches it. it also runs at load to catch updates made while it
was stopped. `publish.ts`:

1. fetches `main` into its own private blobless clone
   (`~/.local/state/app-pins/<app>.git`). the checkout is never read or written,
   so a dirty tree, another branch, or a rebase in progress doesn't matter;
2. runs `record` against that tree: does nothing unless the installed build
   is **newer** than the pin on `main`, then resolves the feed entry for exactly
   that build (not the channel head) with its url and sha256. for rex it also
   advances the linux CLI pin to the bundled commit if newer; helium's linux pin
   is retried each run until its release exists;
3. commits only the changed pin files on top of `main`, signed when
   `commit.gpgsign` is on, as `bump <app> (auto-committed from <host>)` with the
   version change in the body, and pushes. a rejected push (main moved) refetches
   and recomputes; because pins only move up, losing a race to another mac is a
   no-op. it never force-pushes.

each app has its own clone and launchd never runs two copies of one agent, so
agents need no lock. pulling `main` brings the bump into your
checkout like any other commit. `pins.ts record "$PWD"` still writes to the
working tree for manual use.

## install (activation)

`home.activation.installPinnedApps` runs `pins.ts install` for the host's
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
node modules/app-pins/publish.ts --remote git@github.com:bdsqqq/dots.git --host "$(scutil --get LocalHostName)" rex
node modules/app-pins/pins.ts record "$PWD"          # working tree only; all apps, or name them
node modules/app-pins/pins.ts install "$PWD" helium
tail -f ~/Library/Logs/app-pins.log                  # one json event per app/run
launchctl list | grep app-pin
```

## checks

```bash
node --test modules/app-pins/pins.test.ts modules/app-pins/publish.test.ts
(cd modules/pi && pnpm exec tsc -p ../app-pins/tsconfig.json)
```

tests build real app bundles and zip artifacts in temporary directories, and
publish into local bare repositories; they do not touch `/Applications` or GitHub. they don't prove a live Sparkle swap fires the
watcher, or that a dmg mounts on another machine.

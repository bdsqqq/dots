## verification

every change slice must pass the smallest local verification that exercises its
changed behavior. being inside this repository does not by itself warrant
rebuilding the host, but skipping the host build does not waive local
verification.

### full host build

run a full build when changed files can alter nix evaluation or a nix-produced
artifact, including:

- `*.nix`, `flake.nix`, or `flake.lock`
- host imports, nix options, overlays, packages, activation scripts, services, or
  home-manager links
- source files, manifests, patches, hashes, or lockfiles read or copied by nix
- mixed changes containing any of the above

run both commands for the current host:

```bash
# on darwin
nix build .#darwinConfigurations.mbp-m2.system --dry-run
nix build .#darwinConfigurations.mbp-m2.system

# on linux
nix build .#nixosConfigurations.lgo-z2e.config.system.build.toplevel --dry-run
nix build .#nixosConfigurations.lgo-z2e.config.system.build.toplevel
```

do not cross-build by default. when running on darwin, skip linux builds unless
the user asks. when running on linux, skip darwin builds unless the user asks.

### targeted verification

do not run a full host build for documentation, tests, development tooling, or
runtime files reached only through an out-of-store symlink or an absolute path
into the working tree. use the nearest formatter, typecheck, test, parser, or
runtime probe instead. run at least one applicable local check for every slice;
do not substitute inspection when an executable check exists.

for `modules/pi`:

- changes to `modules/pi/default.nix` require a full host build
- changes to `modules/pi/packages/extensions/zmx/package.json` or its
  `zmx-rows.ts` entrypoint require a full host build because
  `modules/zmx/default.nix` reads or copies them through nix
- ordinary extension and core typescript changes do not require a host build;
  follow `modules/pi/AGENTS.md`, run
  `(cd modules/pi && pnpm exec tsc -p tsconfig.build.json --noEmit)`, and run the
  narrowest relevant vitest target
- changes to root exports, generated `dist` output, or extension-manifest
  synchronization require `(cd modules/pi && pnpm run build)`
- `settings.json`, `tool-policy.json`, `keybindings.json`, `models.json`, and
  ordinary extension manifests are runtime inputs; parse them and exercise the
  relevant pi reload/runtime path without rebuilding the host
- prompt changes require the narrowest relevant prompt load or runtime probe,
  not a host build
- dependency or lockfile changes require
  `(cd modules/pi && pnpm install --frozen-lockfile)` plus relevant pi checks;
  add a host build only when nix also consumes the changed file

documentation-only slices require the nearest available markdown or link check.
if no executable check exists, inspect the rendered or consumed artifact and
report that limitation explicitly.

trace ambiguous files before choosing. a nix path copied into the store warrants
a build; a path deliberately resolved from the working tree at runtime usually
does not.

**do not assume nix changes work.** evaluation errors, hash mismatches, and
derivation failures only surface at build time. when the full-build criteria
apply, run the build yourself before asking the user to verify.

common failure modes:
- `hash mismatch` — upstream changed, update the hash
- `cannot create file '/usr/local/...'` — derivation tries to escape sandbox, add `dontBuild` or fix installPhase
- `attribute not found` — typo or missing import

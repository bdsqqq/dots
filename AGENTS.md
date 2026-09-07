## verification

verify each coherent change slice with the smallest executable checks that
exercise its changed behavior. choose verification by how files are consumed,
not just their extension. repeat affected checks after further changes, not
after every intermediate edit.

### 1. local checks — every change

run the nearest applicable parser, typecheck, targeted test, build, or safe
runtime probe. formatting and inspection alone do not verify behavior.

documentation-only changes need the nearest available markdown/link check.
if no executable check exists, inspect the consumed/rendered artifact and
report that limitation.

files used only through out-of-store symlinks or absolute working-tree paths
normally need local/runtime checks, not nix builds. changing the nix wiring
that creates those links also needs evaluation.

### 2. nix evaluation — configuration and evaluation inputs

evaluate an affected output when changing nix expressions, imports, options,
overlays, flake inputs, or files read during nix evaluation. force a relevant
derivation's `.drvPath`; merely listing flake outputs or parsing nix syntax is
not enough. comment/format-only nix changes need only syntax/format checks.

for host/module wiring, evaluate an affected host's system derivation. choose
only a target matching the execution platform:

```bash
# linux default, when lgo-z2e consumes the change
target=nixosConfigurations.lgo-z2e.config.system.build.toplevel

# darwin default, when mbp-m2 consumes the change
target=darwinConfigurations.mbp-m2.system

# run after choosing ONE target above
nix eval --raw --no-write-lock-file ".#${target}.drvPath"
```

use another affected host when the default does not import the changed module.
for isolated packages/checks, evaluate their derivation instead. trace ambiguous
inputs before deciding that a host or package covers them.

evaluation is the normal stopping point for ordinary option/import/link changes
that do not alter build logic or require the integration coverage below.

### 3. targeted nix build — artifact and packaging changes

build the smallest consuming derivation when a change can affect fetching,
patching, compilation, bundling, installation, wrappers, or generated artifact
contents. this includes relevant source files, manifests, patches, fixed-output
hashes, and dependency lockfiles consumed by nix, even when no `.nix` file changes.

changes to runtime code copied into the store need local behavior checks and a
build of the consuming artifact. evaluation-only data changes need evaluation;
they do not automatically require a build if the produced artifact is unchanged.

prefer an existing `packages` or `checks` output, or select the affected
derivation from the evaluated host configuration. a home-manager
`home.activationPackage` build can cover home integration without building the
entire system. do not invent new flake outputs merely to satisfy this policy.

use `nix build --no-link --no-write-lock-file` for verification builds.
evaluation or `--dry-run` does not verify fetch hashes or build/install phases.
building a wrapper also does not replace testing the code it launches.

### 4. full host build — integration escalation

escalate to a full affected host build when:

- the user explicitly requests one or the task is preparing a host deployment;
- core input updates or shared infrastructure changes have broad impact, such
  as a nixpkgs, home-manager, or nix-darwin refresh;
- changes affect boot/kernel/initrd, disks/filesystems, or host-wide security,
  service ordering, or activation behavior that narrower checks cannot cover;
- evaluation and targeted builds leave a concrete integration risk that only
  assembling the host closure can check.

run once for the final coherent change, not for every intermediate edit:

```bash
nix build --no-link --no-write-lock-file ".#${target}"
```

`--dry-run` is optional for estimating the build/download scope, not a mandatory
step before an actual build. mixed changes require the union of relevant checks,
not an automatic full build.

use a native target matching the machine's OS and architecture. do not build
the other OS or every configured host by default. record uncovered platforms.
a build is not activation: do not switch configurations, deploy, or execute
state-changing activation scripts merely to verify a change.

### modules/pi

follow `modules/pi/AGENTS.md` and these consumption boundaries:

- ordinary extension/core typescript: run
  `(cd modules/pi && pnpm exec tsc -p tsconfig.build.json --noEmit)` and the
  narrowest relevant vitest target; no host build;
- root exports, generated `dist`, or extension-manifest synchronization: also
  run `(cd modules/pi && pnpm run build)`;
- settings, tool policy, keybindings, models, ordinary extension manifests, and
  prompts: parse/load them and exercise the relevant reload/runtime path;
- dependencies or lockfiles: run
  `(cd modules/pi && pnpm install --frozen-lockfile)` plus relevant pi checks;
  add nix verification only where nix consumes the changed content;
- `modules/pi/default.nix`: evaluate an affected host; build the home-manager
  activation package when changing generated activation behavior. a full host
  build is not automatic;
- `packages/extensions/zmx/package.json`: evaluate the bin/export contract read
  by `modules/zmx/default.nix`; build the `zmx-rows` wrapper when its generated
  content or selected source changes;
- `packages/extensions/zmx/zmx-rows.ts`: run pi checks and build its consuming
  `zmx-rows` wrapper because nix copies this entrypoint into the store.
  building `pkgs.zmx` alone does not cover that wrapper.

### reporting and limits

report commands/targets run, their outcomes, and meaningful checks skipped with
the reason and remaining coverage gap. distinguish “evaluated”, “artifact
built”, “host built”, and “runtime tested”.

if a selected check is blocked by missing tooling, network/cache failures,
resource limits, or an unexpectedly large build, complete the useful cheaper
checks and report partial verification. do not spend an unbounded amount of
time repairing the environment or retrying unrelated failures. identify the
remaining command rather than claiming verification passed.

never silently downgrade a failed check. evaluation catches missing attributes,
type errors, and assertions in the evaluated path; actual artifact builds check
packaging; runtime probes check behavior. none substitutes for all the others.

common failure modes:
- `hash mismatch` — upstream changed, update the hash
- `cannot create file '/usr/local/...'` — derivation tries to escape sandbox, add `dontBuild` or fix installPhase
- `attribute not found` — typo or missing import

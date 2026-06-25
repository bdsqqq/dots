## verification

this is a nix-darwin + home-manager config. changes must be verified by building the config for the current host platform.

```bash
# on darwin
nix build .#darwinConfigurations.mbp-m2.system --dry-run
nix build .#darwinConfigurations.mbp-m2.system

# on linux
nix build .#nixosConfigurations.lgo-z2e.config.system.build.toplevel --dry-run
nix build .#nixosConfigurations.lgo-z2e.config.system.build.toplevel
```

do not cross-build by default. when running on darwin, skip linux builds unless the user asks. when running on linux, skip darwin builds unless the user asks.

**do not assume changes work.** nix evaluation errors, hash mismatches, and derivation failures only surface at build time. run the build yourself before asking the user to verify.

common failure modes:
- `hash mismatch` — upstream changed, update the hash
- `cannot create file '/usr/local/...'` — derivation tries to escape sandbox, add `dontBuild` or fix installPhase
- `attribute not found` — typo or missing import

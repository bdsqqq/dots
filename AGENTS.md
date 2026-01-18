## verification

this is a nix-darwin + home-manager config. changes must be verified by building.

```bash
# dry-run build (evaluates config, catches most errors)
nix build .#darwinConfigurations.mbp-m2.system --dry-run   # darwin
nix build .#nixosConfigurations.lgo-z2e.config.system.build.toplevel --dry-run  # nixos

# full build (required before shipping)
nix build .#darwinConfigurations.mbp-m2.system   # darwin
nix build .#nixosConfigurations.lgo-z2e.config.system.build.toplevel  # nixos
```

**do not assume changes work.** nix evaluation errors, hash mismatches, and derivation failures only surface at build time. run the build yourself before asking the user to verify.

common failure modes:
- `hash mismatch` — upstream changed, update the hash
- `cannot create file '/usr/local/...'` — derivation tries to escape sandbox, add `dontBuild` or fix installPhase
- `attribute not found` — typo or missing import

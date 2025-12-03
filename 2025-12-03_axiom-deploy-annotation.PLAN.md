# axiom deploy annotation

## goal
create an annotation in axiom when deploying a new nix generation to any host

## approach
1. create a shell script `scripts/nix-deploy-annotate.sh` that:
   - reads axiom token from `/run/secrets/axiom_token`
   - detects darwin vs linux
   - gets current generation info from `/nix/var/nix/profiles/system`
   - posts annotation to axiom api

2. add script to environment.systemPackages via a new module or existing bundle

3. usage: run after successful rebuild:
   ```bash
   darwin-rebuild switch --flake ... && nix-deploy-annotate.sh
   nixos-rebuild switch --flake ... && nix-deploy-annotate.sh
   ```

## annotation payload
```json
{
  "time": "<iso timestamp>",
  "type": "nix-deploy",
  "datasets": ["papertrail", "host-metrics"],
  "title": "<hostname> gen <N>",
  "description": "nix generation <N> deployed to <hostname>",
  "url": "<link to generation path or closure>"
}
```

## tasks
- [x] create plan
- [x] create script (`system/deploy-annotate.nix`)
- [x] add to nix config (via `bundles/base.nix`)
- [x] test build (darwin-rebuild build succeeds)

## auto-fire implementation
- darwin: launchd daemon `dev.bdsqqq.nix-deploy-annotate` runs at load
- linux: systemd oneshot `nix-deploy-annotate.service` after sops-install-secrets

idempotency: tracks last-annotated generation in `/var/lib/nix-deploy-annotate/last-generation`

manual cli still available: `sudo nix-deploy-annotate`

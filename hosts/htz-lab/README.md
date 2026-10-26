# htz-lab

an independent CX33 agent host, not a renamed `htz-xfs-lab`. the old host remains
usable with its own volume, tailnet identity, SSH identity, and T3 environment.

- root and working data use this machine's 80 GB disk. the
  [existing encrypted OpenTofu workspace](../htz-xfs-lab/main.tf) retains both
  resource addresses; its VDO attachment is pinned to the old host.
- SSH host keys are generated on this machine. their age recipient grants only
  the credential owners this role consumes. machine enrollment uses its own
  `tailscale/secrets/machines/htz-lab.yaml`; no tailnet state is transferred.
- bootstrap the editable checkout at `/home/bdsqqq/commonplace/01_files/nix`
  before Home Manager starts: tool installation and runtime use that same live
  manifest. before native hourly upgrades, Git fetches and fast-forwards this
  checkout without autostashing conflicting work. after activation, Home Manager
  reruns the existing dependency installation/build hooks even if its own
  derivation is unchanged. `systemctl start nixos-upgrade.service` is manual
  catch-up; resolve a rejected Git merge rather than discarding unpublished work.
- [native T3 service wiring](../../modules/t3-code/server.nix) supplies prerequisites
  and a drop-in, not a copied service or database. install T3 as `bdsqqq`, then
  pair this fresh environment in the app. provider and Google sign-ins are not
  copied; Google runner authorization remains disabled until explicitly selected.

initially copied home/root/SSH material was authenticated after encryption to
the owner's recovery recipient and quarantined outside the installed root. its
recovery archive is `/var/lib/htz-lab-bootstrap/pre-independent-host.tar.age`.
this archive is not active identity or application state.

`node --experimental-strip-types --test hosts/htz-lab/host.test.ts` checks the
identity declaration and rejects inherited storage/enrollment fixtures. on
native x86 Linux it also evaluates the role and forces the system derivation.
boot, secret decryption, fresh tailnet enrollment, and an authenticated T3 app
connection require separate runtime verification; an HTTP 200 is not registration.

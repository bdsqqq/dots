# terraria backup

the mini backs up its existing synced archive, not a removable volume.
the host supplies `my.backup.terraria.saveRoot`; this module neither enables
syncing nor creates or replaces saves. `plan.json` preserves the hourly
last-run schedule and excludes Syncthing's metadata/version directories.
policy edits require Nix activation, as with the parent engine's other plans.

the shared destination is imported through `../ssd-01/repository.nix`, which
requires its password owner but does not enable the SSD plan. Terraria keeps
its own source-presence guard, all-snapshot retention, and unchanged-file
skipping; an absent SSD cannot cancel this job.

for a manual catch-up, run the `terraria` plan in the mini's Backrest UI.
inspect its result separately from `ssd-01`; a completed attempt is not restore
evidence. the isolated runtime test in `../test_runtime.ts` performs a real
local backup and historical restore without accessing live saves or Hetzner.

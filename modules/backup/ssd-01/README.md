# ssd-01 backup

`mmn-m4` and `mbp-m2` import this drive-specific policy; [the parent](../README.md) owns
the Backrest daemon, configuration replacement, and scheduling. the existing
repository identity, all-snapshot retention, weekly 5% repository check,
unchanged-file skipping, and `--one-file-system` are preserved. mmn's hourly
terraria plan explicitly selects the same repository without any SSD gate.
`repository.nix` owns that shared destination and credential dependency;
importing it alone does not enable the SSD plan.

## each host has its own clock

each Backrest instance schedules an SSD attempt 24 hours after its last
completed attempt, including cancelled and failed attempts. history is local
to each host/instance, not a shared global clock. moving or reconnecting the
drive does not trigger a run or merge histories. the machine with the drive
backs it up when its own schedule asks; the other cancels quietly. a manual
Backrest run remains available: select the `ssd-01` plan in the local Backrest
UI and start a backup. the old standalone initial-upload script is retired;
manual runs now use the same policy, credentials, and restore hooks as scheduled
runs, rather than a second decryption/upload implementation.
no coordinator, extra timer, or shared state
database is introduced.

## hooks and safety

1. `presence` cancels with exit 75 if `/Volumes/ssd-01` is absent. Backrest still
   records a cancelled operation and hook logs; quiet means no user notification.
2. `prepare` checks diskutil's mounted state, mount point, and UUID, both real
   source directories, and the photo export database. wrong or incomplete mounts
   fail fatally. only after validation does it install/update the restore canary.
3. `verify` restores that canary from the actual new snapshot into a temporary
   directory, checks the contents, cleans up, and notifies success. restore errors
   notify and fail the hook. an empty snapshot ID (unchanged files or a dry run)
   does nothing; it is not restore evidence.
4. `error` notifies snapshot errors and partial-backup warnings. it suppresses
   only the dedicated snapshot-start cancellation ending in `exit status 75`,
   not drive absence discovered after an actual backup error.

Backrest 1.13.0's [snapshot-start failure path](https://github.com/garethgeorge/backrest/blob/v1.13.0/internal/orchestrator/tasks/taskbackup.go#L150-L154)
calls [NotifyError](https://github.com/garethgeorge/backrest/blob/v1.13.0/internal/orchestrator/tasks/errors.go#L42-L55)
even after cancellation. [ExecuteHooks](https://github.com/garethgeorge/backrest/blob/v1.13.0/internal/orchestrator/taskrunnerimpl.go#L118-L126)
wraps the command exit error as `TaskCancelledError`. the tests check this
pinned source contract as well as negative error-message fixtures. an engine
upgrade that changes those messages needs a fresh trace. validation does not
lock a removable volume against unplugging; later backup errors still notify.

## live files and credentials

hooks execute the absolute live checkout path under
`my.paths.commonplace/01_files/nix/modules/backup/ssd-01`, using Node 24 supplied
by Nix. `hooks.ts`, `drive.json`, and `canary.txt` are read there, not copied into
the store. editing hooks/canary takes effect on the next invocation. drive identity,
repository, and source changes also need the ordinary Nix policy activation:
Backrest's generated plan consumes `drive.json` at evaluation time. each hook
receives that file's evaluated SHA-256 fingerprint and refuses drive actions if
the live bytes differ, rather than validating new paths for an old plan. this
also makes formatting-only edits require policy activation. error notification
does not load policy/canary files, so it remains available during drift or parse
failures. verification bootstrap failures also notify before failing. the
fingerprint binds configuration, not script
authority; it does not sandbox editable code.

the encrypted password stays in `modules/backup/ssd-01/secrets.yaml`, with its adjacent
`credential.nix` as owner. importing this module requires that owner: SOPS
provisions a user-readable `0400` runtime file and Backrest consumes
`RESTIC_PASSWORD_FILE`. missing decryption capability is an actual provisioning
failure, not an undocumented path assumption.

SSH identity/trust remain host-owned: `my.ssd01Backup.sshKeyPath` and
`knownHostsPath` default to the user's `.ssh/id_ed25519` and `.ssh/known_hosts`.
the module never generates, distributes, overwrites, or enrolls them. SSH uses
port 23, batch mode, identities-only, no identity agent, strict host-key checking,
and bounded connection attempts.

after drive validation, before canary writes, readiness checks nonempty readable
credential files and runs a bounded `restic --no-lock cat config`, checking the
repository GUID. failure stops the backup without leaking child output. the
timeout also terminates the SSH process group. an absent drive still cancels
before any credential/network check; notification hooks need no credentials.
no network probe runs during activation. real decryption, SSH authorization,
macOS permissions, and physical-drive recovery remain unverified.

## isolated checks

from the repository root, with existing TypeScript/Node tooling:

```sh
node --test modules/backup/ssd-01/hooks.test.ts
tsc --noEmit -p modules/backup/ssd-01/tsconfig.json --typeRoots modules/pi/node_modules/@types
node modules/backup/ssd-01/hooks.ts --help
```

set `BACKREST_SOURCE` to the pinned Backrest 1.13.0 source directory to include
the source-contract test; otherwise that check is explicitly skipped. adapters
mock diskutil, restic, notifications, and all drive/restore writes. help and the
tests' policy-bound empty-snapshot probes do not touch a drive, decrypt secrets,
or contact a repository. stale-policy fixtures reject changed live sources before
native drive commands run.
tests include known negative fixtures for path/identity validation, cancellation
filtering, and host/module contracts. source tracing and mocked behavior do not
prove daemon delivery, real backups, restore recovery, or physical sleep/wake
behavior. evaluate both Darwin host system derivations before integration.

set `SSD_TEST_RESTIC` to a built restic binary and `SSD_TEST_TIMEOUT` to GNU
timeout for the local password-file integration and process-group deadline
fixtures. they create only temporary local repositories/processes: correct
credentials succeed, wrong passwords/GUIDs fail, and no SSH/remote repository
is contacted. missing binaries explicitly skip these optional fixtures.

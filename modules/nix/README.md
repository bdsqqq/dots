# upgrade convergence

an hourly trigger is not evidence that a host applied anything. the opt-in darwin
supervisor pins one published revision, builds it with an owned-process deadline,
and verifies the applied revision and dependency check before reporting success.
unchanged revisions are checked without reactivating the system. retry backoff
belongs to the failed revision; a newly published fix starts a fresh bounded
attempt without waiting for an older revision's retry deadline.

## safety boundaries

- a timed-out build cannot replace the running generation. cancellation targets
  only the process group created by that attempt, never the shared nix daemon.
- activation has an observation deadline, not a kill timer: native activation can
  mutate home-manager files and third-party packages and is not a transaction.
- failed or interrupted activation is quarantined. after inspecting the partial
  state and confirming no previous activation is running, an operator can run
  `sudo host-upgrade run --acknowledge-interrupted`. timers cannot acknowledge it.
- an os-released sqlite lock prevents concurrent invocations. a proven reboot
  permits retrying pre-activation work; interrupted native writes stay quarantined.
  same-boot orphaned work is not assumed safe to repeat.
- homebrew failures remain partial even when nix-darwin completes. presence checks
  cannot erase a failed installer. the declared bundle installer gets at most
  three isolated repair attempts per revision; no trust grants or developer-tool
  installation are added. overdue native repairs are escalated, not killed.
- status contains only bounded operational metadata; editable tracked files and
  unpublished changes are never reset or replaced by the supervisor.

launchd invokes the runner through the system profile and a stable `/etc` config
path. embedding a new store path in its plist would unload an updater during its
own activation. the first migration must therefore be activated outside the old
updater job: temporarily disable its timer, build the published candidate, then
run its `sw/bin/host-upgrade run --config <candidate>/etc/host-upgrade.json
--revision <published-sha>` as root outside launchd. using the coordinator also
holds the attempt lock if nix-darwin's `launchctl load -w` re-enables calendar
triggers during activation. re-enable and start the new job after completion;
do not use a partially applied migration as proof of convergence.

## passwordless operator requests

`supervision.passwordlessOperator` is opt-in per host. on the mini, the primary
user can request either fixed root job over ssh or locally:

```sh
sudo -n /bin/launchctl kickstart system/org.nixos.darwin-upgrade
# only after inspecting a failed activation and confirming native writes stopped:
sudo -n /bin/launchctl kickstart system/org.nixos.darwin-upgrade-recovery
```

neither command accepts extra arguments. there is no arbitrary shell, installer,
config path, `launchctl -k`, or permission to manage other jobs. both run detached
from ssh under launchd and share the coordinator lock. recovery has no timer,
run-at-load, or keepalive trigger; naming that job is the explicit acknowledgement.
root-owned config and program paths retain the existing published-repository trust
boundary. a compromised operator account can request these two operations, not an
arbitrary root command. inspect status and logs rather than treating kickstart's
exit code as successful activation.

## evidence and escalation

`host-upgrade status` is read-only. the registry reads the same safe status file
and reports `host.upgrade_health`; active work is unknown, not recovery. a relay
observer independently evaluates fresh telemetry and these reports. app readiness
is checked separately, so a current nix generation cannot hide unavailable lights
or a nonresponsive backend.

failure qualification and recovery belong to the existing incident ledger, not
to a restart loop. its five-minute failure qualification and ten-minute measured
recovery avoid repeated notifications; missing observations cannot close an
incident. this path still depends on axiom and is not out-of-band paging.

local failure fixtures need no root privileges or real activation:

```sh
node --experimental-strip-types --test modules/nix/host-upgrade.test.ts
```

`checks.service-events` includes the supervisor fixtures; a native affected-host
build and real post-activation checks remain necessary before claiming rollout.

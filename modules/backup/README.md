# backup boundaries

sharing a destination should not couple independent sources. a removable
volume needs evidence that the intended volume is mounted; another source
should not inherit that requirement merely because it uses the same storage.
put failure conditions with the data they protect.

## explicit feature imports

importing `modules/backup` provides the engine, not every backup policy.
[ssd-01](ssd-01/README.md) is selected on both Macs;
[terraria](terraria/README.md) is selected only on the mini. its host wires
the existing synced save root into `my.backup.terraria.saveRoot`.

both policies use `ssd-01/repository.nix`: one destination identity, static
password owner, and SSH transport, without importing the SSD plan. the encrypted
password lives beside that owner; mutable SSH keys and trusted hosts remain
host-owned. repository selection must not imply removable-drive presence.

## policy and history have different lifecycles

configuration expresses what should run. operation history records what
actually happened. replacing policy must not erase history, change an existing
repository's identity, or imply permission to initialize another repository.

combining declarative policy with persistent UI edits requires rules for
conflicts, deletions, and ownership. choosing one policy authority avoids that
second configuration system. a UI can remain useful for inspection and manual
operations without becoming another durable policy store.

## scheduling is not recovery

an elapsed interval and a calendar appointment answer different questions.
downtime introduces another choice: wait for the next appointment or attempt an
overdue backup. keeping that decision with the backup engine avoids splitting
scheduling and history across independent clocks.

a completed attempt is not necessarily a successful snapshot. reconnecting
storage does not, by itself, establish that a missed backup has been retried.

## reachability is not recoverability

a reachable daemon does not establish that every source was available, a recent
backup succeeded, or a snapshot can be restored. keep service availability,
backup results, and restore evidence separate.

test restoration into a separate destination. recovering over live data turns
a verification exercise into another possible source of loss.

# native pi memory runtime

`openMemoryApplication()` composes native configuration, durable Markdown,
source capture, recall, reconciliation and SSH replication. importing the SDK
starts nothing. production opening and store operations yield and retry bounded
SQLite contention instead of blocking inference or requiring caller retry loops.
filesystem work remains synchronous: create/close the application in a worker or
standalone process. interactive Pi uses `SessionMemoryWorker`, never this store
on its inference event loop. synchronous `createMemoryApplication()` remains a
compatibility entrypoint, not the production contention-safe opener.

```ts
import { openMemoryApplication } from "@bdsqqq/pi/core/agent-memory";
async function reconcilePending(signal: AbortSignal) {
  const app = await openMemoryApplication({}, signal);
  try {
    return await app.reconcile(signal);
  } finally {
    app.close();
  }
}
```

opening cancellation covers acquisition, not the successful store's later
operations. per-operation signals fence cancellation while durable shutdown retry
can still finalize. supply `configuration`, `model`, `index` or `transport` only
when the caller owns that boundary. supplied snapshots in `catchUpNativeSources` bypass source reads.
SDK capture/recall/dispatch and the JSON adapter use the shared handlers, rather
than separate policies. the SDK also exports `capture`, `runReconciliation`,
`reconcile`, `nativeConsolidationModel`, `sharedRecallHandler`,
`sharedDispatchHandler`, `LinkedSearchIndex`, `FileMemoryStore`, native source
helpers, configuration, replica ports, contracts and worker configuration.

## configuration and independent maintenance

editable native `settings.json` owns `@bds_pi/agent-memory`: `enabled`, `root`,
`data`, `state`, `ownerId`, `model`, `peers` and `backlog`. unrelated settings,
credentials and session selection are untouched. use absolute namespace paths for
one shared interactive/background instance: relative paths resolve from the caller's
working directory. omitted model/auth use Pi's native runtime; this module does
not select a T3 provider or require T3.

`PI_MEMORY_ROOT`, `PI_MEMORY_DATA_DIR`, `PI_MEMORY_STATE_DIR`, `PI_MEMORY_OWNER`,
`PI_MEMORY_MODEL` and JSON `PI_MEMORY_PEERS` override native namespace values.
`PI_MEMORY_DEFAULT_PEERS` is a lower-priority deployment fallback. an explicit
native empty roster disables that fallback. peers are trusted same-owner SSH
destinations; the adapter grants personal and all-owned project replication
from local configuration, never received JSON.

all adapters call `runtimeStoreConfiguration`: notes at `<root>/runtime`, durable
objects at `<data>/runtime`, coordination/progress at `<state>/runtime`, and
hostname replica identity. these runtime children coexist with legacy data.
the extension snapshots finalized turns, but publishes their capture after the run
settles or shuts down so writes do not consume provider-time eligibility budgets.
persistent sessions also have independent disk catch-up; a hard-killed, unfinished
in-memory run can lose its unpublished snapshots.
source discovery follows native session-root settings/environment selection.
live capture selects its native through-entry; disk sweeps visit every leaf in
that authorized session root. both preserve session/entry IDs, roles and authored
times; compaction/custom summaries are not independent experience. default project
observation runs off the inference loop using the workspace's local Git remote.
supplied project context bypasses discovery; explicit null disables it. unavailable
workspaces remain personal, and today's HEAD is never claimed as an old event's revision.

Nix supplies Node, Python 3 (Darwin `F_FULLFSYNC`), SSH and compatibility Git.
its launcher resolves dependencies and source from the same editable live tree.
owner devices supervise separate `catch-up`, `reconcile` and `replicate` jobs
every minute through launchd/systemd. `htz-xfs-lab` runs capture/reconciliation
and serves authenticated inbound exchange: its existing tailnet policy forbids
initiating owner-device SSH, and owner-initiated exchange transfers both ways.
the wake interval does not kill running work. capture and sync
continue while consolidation waits on a model, independently of interactive
sessions. `maintain` composes these same handlers concurrently, awaits all owned
phases before close, and reports aggregate failure rather than hiding it.
disabled automatic maintenance does not export existing memory.
directory/span cursors and append-prefix fingerprints survive process exit, but
retained acceptance receipts—not progress files—establish coverage after a restore.
replayable capture intents retain the first acceptance clock, so old source dates
do not age new pending work. appends resume retained spans; the native snapshot
loader still reads a whole session before bounded windows are selected.
pending-age/threshold/recovery and durable no-change/backoff prevent empty
thinking runs. reconciliation renews logical ownership across long model work
without holding a SQLite transaction; lost/reclaimed owners cannot accept late
output. caller budgets remain explicit; there is no default whole-job/model kill.
retry outcomes stay host-local and are deliberately absent from replica scans.
replication has its own bounded retry state; a failed peer does not revoke local
acceptance. incremental disclosure proofs bind exact payloads, local policy and a
retained-history continuity epoch. append/restart preserve that epoch; removed or
replaced history invalidates cached descendants. lost proofs rebuild bounded causal
prefixes with backoff, rather than imposing a lifetime history ceiling. transport
liveness limits belong to each exchange, not the background job. configured peer
attempts progress independently; safe diagnostics identify known failure boundaries
without echoing peer-controlled stderr or private note/provider data.

`maintain` and `replicate` are manual catch-up commands too. process tests prove
fixture propagation; deployment, service activation and real fleet convergence
require separate authorization and verification.

## cli and bounded JSON

source: `node --import jiti/register packages/core/agent-memory/index.ts <command>`
from `modules/pi`. built: `node dist/core/agent-memory.js <command>`; the package
also exposes the `pi-memory` executable.

| command | stdin object | result |
| --- | --- | --- |
| `status` | none | local notes/suppressions, paths and configured peers |
| `catch-up` | none | bounded native-source capture and progress |
| `reconcile` | none | eligible backlog, renewable ownership and durable outcomes |
| `maintain` | none | concurrent capture/reconciliation/replication; waits for all phases, reports failure |
| `replicate` | none | bounded per-peer synchronization/backoff/errors |
| `capture` | `{ "windows": [...] }` | shared capture receipt for validated source windows |
| `recall` | `{ "intent": {...} }` | shared queued/empty/discarded outcome |
| `suppress` | `{ "suppression": {...} }` | durable local receipt |
| `import-legacy` | `{ "paths": ["/explicit/note.md"] }` | per-file import receipts |
| `json` | one of these objects plus `"command"` | same handler/result |
| `exchange` | bounded replica wire request | SSH-authenticated replica response only |

requests and responses are one JSON value per invocation; stdin is bounded to
1 MiB. stdout holds protocol results; errors go to stderr with nonzero exit.
local CLI/SDK callers exercise owner authority. JSON cannot override root,
configuration or peer identity. `recall` queues a durable result; an SDK/native
inbox consumer still dispatches and rechecks it before provider consumption.

`exchange` requires `SSH_CONNECTION`. the local resolver runs `ssh -G` for each
trusted alias before DNS, then matches the incoming remote address to exactly
one configured destination. non-SSH, unknown, unresolved or ambiguous bindings
fail closed. wire input cannot name an authenticated peer, root or owner. this
uses existing SSH account authentication and local address trust; it adds no
listener, keys or enrollment. shared/NAT addresses can be ambiguous and will
need an explicitly authorized identity design before use. tests inject a trusted
resolver and never probe real SSH, DNS or credentials.

## explicit historical compatibility and import

these commands retain their historical dispatcher and options:
`project-proposals`, `project-resolve`, `propose`, `proposals`, `show`, `review`,
`history` (including `history verify`), `catalog`, `migrate`, `request`, `rollback`.
`legacy <command>` explicitly reaches any old command, including colliding
`legacy maintain`, `legacy status` and `legacy health`. the historical engine
uses its existing Git/configuration boundary; the Nix wrapper supplies its remote
only through `PI_MEMORY_LEGACY_GIT_REMOTE`, mapped when a legacy command runs.
legacy `request` records legacy demand; run `legacy maintain` to process it.
the default supervisor processes native runtime work only. installed skills and
the old engine remain intact until their consumers migrate. legacy Git publication
is separate from checkout materialization: the latter stays degraded when the
reserved `<root>/runtime` path is enrolled, rather than swapping away live notes.
interrupted legacy backups containing native data refuse cleanup and require
explicit recovery. no automatic relocation or private-data migration occurs.

`import-legacy` is separate from historical `migrate`. it requires an explicit
1..128-file list, limits each file to 128 KiB, archives exact original bytes,
keeps originals/history untouched and creates descriptive stable-ID Markdown.
links between files in the supplied set become permanent ID links in metadata;
original prose/links remain in the body. claims are attributed to observation of
historical derived Markdown, not original user statements or current code truth.
imports are deterministic/replayable and need no Git or model. imported evidence
can subsequently enter ordinary consolidation. changed originals yield explicit
conflicts rather than replacing prior imported notes. no startup migration runs.

local runtime and fixture checks do not prove physical power-loss behavior or
live peer authentication. no private-data migration or service activation is part
of these checks.

# native pi memory runtime

`createMemoryApplication()` composes native configuration, durable Markdown,
source capture, recall, reconciliation and SSH replication. importing the SDK
starts nothing. create/close the application in a worker or standalone process:
the file store uses synchronous SQLite/filesystem operations. interactive Pi
uses `SessionMemoryWorker`, never this store on its inference event loop.

```ts
import { createMemoryApplication } from "@bdsqqq/pi/core/agent-memory";
const app = createMemoryApplication();
try {
  await app.maintain(AbortSignal.timeout(120_000));
} finally {
  app.close();
}
```

supply `configuration`, `model`, `index` or `transport` only when the caller owns
that boundary. supplied snapshots in `catchUpNativeSources` bypass source reads.
SDK capture/recall/dispatch and the JSON adapter use the shared handlers, rather
than separate policies. the SDK also exports `capture`, `runReconciliation`,
`reconcile`, `nativeConsolidationModel`, `sharedRecallHandler`,
`sharedDispatchHandler`, `LinkedSearchIndex`, `FileMemoryStore`, native source
helpers, configuration, replica ports, contracts and worker configuration.

## configuration and independent maintenance

editable native `settings.json` owns `@bds_pi/agent-memory`: `enabled`, `root`,
`data`, `state`, `ownerId`, `model`, `peers` and `backlog`. unrelated settings,
credentials and session selection are untouched. omitted model/auth use Pi's
native runtime; this module does not select a T3 provider or require T3.

`PI_MEMORY_ROOT`, `PI_MEMORY_DATA_DIR`, `PI_MEMORY_STATE_DIR`, `PI_MEMORY_OWNER`,
`PI_MEMORY_MODEL` and JSON `PI_MEMORY_PEERS` override native namespace values.
`PI_MEMORY_DEFAULT_PEERS` is a lower-priority deployment fallback. an explicit
native empty roster disables that fallback. peers are trusted same-owner SSH
destinations; the adapter grants personal and all-owned project replication
from local configuration, never received JSON.

all adapters call `runtimeStoreConfiguration`: notes at `<root>/runtime`, durable
objects at `<data>/runtime`, coordination/progress at `<state>/runtime`, and
hostname replica identity. these runtime children coexist with legacy data.
source discovery follows native session-root settings/environment selection.
catch-up reads raw selected native branches, preserving session/entry IDs,
producer roles and authored times; compaction/custom summaries are not new
experience. project identity remains optional producer-supplied context, as in
the extension; catch-up does not invent a repository identity from a directory.

Nix supplies Node, Python 3 (Darwin `F_FULLFSYNC`), SSH and compatibility Git.
its launcher resolves dependencies and source from the same editable live tree.
launchd/systemd run bounded `maintain` processes every minute, independently of
interactive sessions. each pass captures bounded source pages, reconciles at
most one eligible batch, then retries configured peers. directory/span cursors
and append-prefix fingerprints survive process exit. unchanged files need only
metadata checks; appends resume retained spans. pending-age/threshold/recovery
planning and durable no-change/backoff prevent empty thinking runs. replication
has its own durable bounded retry state; a failed peer does not revoke local
acceptance. the CLI aborts at 150 seconds and terminates at 155 seconds.

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
| `maintain` | none | capture, eligible reconciliation and replication outcomes |
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
the old engine remain intact until their consumers migrate.

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

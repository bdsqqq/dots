# pi agent-memory maintainer redesign

- **status:** proposed architecture and phased implementation plan
- **scope:** pi agent-memory maintenance, cross-host canonical serialization, projection, workflow recovery, scheduling, reflection, proposal admission, indexing, observability, evaluation, and retention
- **preserved boundaries:** local-first reads and proposal preparation, file-backed records, canonical markdown artifacts, review receipts, reversible append-only history, existing model audit isolation, and current extension-facing memory paths
- **out of scope:** microservices, a general workflow platform, peer-to-peer consensus, universal event sourcing, prompt-quality redesign, and task-uplift-gated memory admission
- **date:** 2026-09-03

> architecture authored by oracle from amp’s verified code/runtime investigation; persisted by amp because oracle is read-only.

## executive decision

**change both the workflow boundary and the cross-host mutation boundary. do not stop at optimizing the monolithic loops.**

the target is a local, file-backed maintainer built from:

1. host-local durable workflow records rather than one long-running maintenance procedure;
2. an incremental source registry rather than repeated corpus discovery and parsing;
3. independently invocable reconcilers rather than one command owning every phase;
4. one durable host-global demand path rather than process-local debounce plus detached workers;
5. isolated proposal branches that never modify the usable canonical checkout while work is being prepared;
6. `origin/main` as the sole cross-host serialization authority, using a verified fast-forward compare-and-swap merge;
7. a verified local checkout and qmd source projection derived from the accepted remote head;
8. a canonical admission gate based on provenance, epistemic integrity, safety, and convergence—not measured task uplift;
9. one bounded context-rich event per significant operation, written to a size-bounded local jsonl transport and exported by the OpenTelemetry collector to Axiom as runtime telemetry.

the model boundary is proposal-only, matching the intended product model. the premise correction is that current maintenance does not stop there: consolidation, deterministic maintenance, and corpus maintenance call `applyMemoryProposal`, which records an autonomous acceptance and mutates canonical files through the transaction path ([`index.ts`](modules/pi/packages/core/agent-memory/index.ts#L1688-L1722), [`index.ts`](modules/pi/packages/core/agent-memory/index.ts#L1915-L1945), [`index.ts`](modules/pi/packages/core/agent-memory/index.ts#L3070-L3102), [`workflow.ts`](modules/pi/packages/core/agent-memory/workflow.ts#L2004-L2035)). the redesign keeps maintenance running but redirects application into isolated branch preparation followed by serialized merge.

accepted commits reachable from `origin/main`, every historical canonical memory version they contain, their history-verification receipts, and their accepted canonical-evidence capsules are retained indefinitely. later correction uses a compensating commit; retention never rewrites or truncates accepted history.

`origin/main` is the single logical memory pool and audit authority. each accepted Git commit is an immutable shared record containing canonical markdown, its mutation receipt, and a bounded safety-filtered evidence capsule for every added or materially changed durable claim. the mutable `main` ref is updated only by fast-forward compare-and-swap. each host retains a verified local checkout for offline retrieval and may prepare proposals while disconnected; a proposal is not merged until the remote accepts its commit.

raw sessions remain owned by their configured source producers; the maintainer never deletes them. prompts, copied source snapshots, complete model outputs, tool transcripts, and replay artifacts remain host-local preparation evidence. once no active work references those artifacts, they may expire only after every accepted claim that depended on them is represented by a verified canonical-evidence capsule.

the canonical memory subtree must be excluded from the `commonplace` Syncthing folder on every peer. Syncthing remains appropriate for the surrounding tree, but it must not be a second transport for canonical memory. `.stversions`, `*.sync-conflict-*`, unverified branches, and local workflow state are never qmd inputs.

this selects Git serialization over the two other viable designs:

| design | strength | cost | decision |
|---|---|---|---|
| Git remote serializes `main` | reuses the existing verified history and remote; produces one linear accepted order; offline reads and branch preparation still work | a merge waits while the remote is unavailable | **default** |
| host-unique immutable mutation records plus deterministic materialization | permits fully peer-to-peer offline acceptance | requires total ordering, replay, conflict arbitration, retractions, and projection semantics close to an event-sourced or CRDT design | reject unless offline completion of concurrent merges becomes mandatory |
| designated writer | simple single-writer correctness | creates an availability bottleneck and prevents another host from merging while the writer is absent | reject as the steady-state architecture; acceptable only as a temporary migration compatibility mode |

reverse this decision only if a completed canonical merge—not merely proposal preparation—must succeed while every shared remote is unavailable. that requirement would justify immutable peer records plus deterministic materialization. a trusted always-on writer with an explicitly accepted availability dependency would instead justify the designated-writer alternative.

optimizing `findProposal`, adding more debounce, or skipping obviously unchanged files still matters, but it would not solve cross-host authority, recovery, scheduling, continuation, failure state, or model execution coupling. the proposed boundaries change no-op work from corpus-sized to constant or bounded metadata work, append processing from corpus-sized to changed-source work, recovery from historical-record-sized to incomplete-work-sized, and cross-host mutation from competing filesystem writes to one linear compare-and-swap history.

file-backed records remain the decision. sqlite is not a fallback implied by this plan; adopting it requires a new explicit decision.

## decision status

- [x] [continue maintenance through isolated branch work](#decision-pause-autonomy)
- [x] [use Git `origin/main` as canonical serialization authority](#decision-canonical-authority)
- [x] [use one shared logical memory pool and hard qmd exclusions](#decision-source-policy)
- [x] [keep storage file-backed](#decision-storage)
- [x] [limit model invocation concurrency to one per host](#decision-slo-budgets)
- [x] [treat finite resource limits as measured implementation safeguards](#decision-slo-budgets)
- [x] [transport bounded runtime events to Axiom](#decision-retention)
- [x] [retain canonical knowledge, receipts, and bounded supporting evidence indefinitely; clean up only noncanonical operational artifacts](#decision-retention)
- [x] [adopt the proposed model timeout and retry policy](#decision-model-retry)
- [x] [adopt the proposed pending-proposal expiry policy](#decision-proposal-expiry)
- [x] [gate canonical admission on integrity rather than task uplift](#decision-canonical-admission)
- [x] [allow the bounded append fast path for configured trusted session producers](#decision-source-mutation)

## goals and invariants

the redesign is complete only when these invariants hold:

- `origin/main` is the only canonical cross-host mutation authority;
- canonical history is linear, append-only, and updated only by fast-forward compare-and-swap;
- no host edits its usable canonical checkout while preparing or reviewing a proposal;
- a local commit, review receipt, or successful file mutation is not reported as merged until the remote has accepted the corresponding commit;
- a host may read its last verified canonical checkout and prepare proposals while offline;
- a disconnected host reports remote lag as unknown or stale, not as globally current;
- concurrent disjoint proposals rebase onto the latest accepted head; a changed target path blocks rather than invoking generic textual conflict resolution;
- canonical memory files are excluded from Syncthing on every peer, eliminating dual replication authority;
- `.stversions`, `*.sync-conflict-*`, proposal branches, and unverified artifacts never enter qmd;
- a process may terminate after any durable transition without losing accepted local work;
- restarting reconciles current records toward desired state rather than replaying historical terminal records;
- an unchanged source causes no source-content read and no source, projection, or job rewrite;
- a configured trusted append-only session producer normally costs the appended bytes, a bounded continuity proof, and affected projection fragments;
- non-append evidence, an untrusted source policy, or a failed continuity check selects complete streaming validation and quarantine on failure;
- the append fast path does not claim to detect arbitrary edits outside the checked boundary of an already accepted prefix;
- terminal transactions and terminal workflows are not part of normal recovery scans;
- repeated triggers coalesce durably across extension processes, timers, and continuations on one host;
- every runnable unit has a lease, a finite work boundary, a typed outcome, and an independently invocable entrypoint;
- exact slice, byte, concurrency, hint, buffer, backlog, and lock values are implementation tuning selected from measurements rather than user-approved product policy;
- waiting and retrying consume no worker or checkout lock;
- model inference never occurs while holding the canonical checkout lock;
- at most one model invocation runs concurrently per host;
- retries retain their reason, basis, attempt, and next eligible time;
- queue pressure cannot create unbounded in-memory collections or monopolize one lane;
- automatic merge readiness fails closed when provenance, epistemic integrity, safety, expiry, or convergence evidence is missing or incompatible;
- retrieval evaluation remains available as a diagnostic but cannot decide whether a well-provenanced event belongs in memory;
- accepted Git commits, historical canonical memory versions, commit-encoded history-verification receipts, accepted admission summaries, and canonical-evidence capsules are retained indefinitely;
- every added or materially changed durable claim maps to retained claim-bearing evidence in the same accepted history; a source digest or admission attestation alone is not supporting evidence;
- nonterminal host-local work and every artifact it references remain available until the work reaches a safe terminal state;
- configured source files remain producer-owned and are never deleted by the maintainer; their later disappearance does not break accepted auditability after canonical-capsule verification;
- copied source snapshots, prompts, complete model outputs, tool transcripts, replay evidence, terminal workflows, local projections, and local telemetry are noncanonical operational data. they may expire after reference tracing and canonical-capsule verification;
- local jsonl and pi’s Axiom wide-event stream contain runtime telemetry only and are never workflow, recovery, evidence, admission, or merge authority;
- Axiom or collector failure never changes workflow or merge outcomes;
- health output distinguishes authority/convergence, integrity, activity, operational health, retrieval diagnostics, local cleanup, and telemetry transport.

## evidence and diagnosis

`VERIFIED` means traced in code or measured by amp’s runtime investigation. `HUNCH` means evidence supports a possibility but not a conclusion. `QUESTION` means the architecture depends on an unresolved product or policy choice.

### activity

| status | claim | evidence | falsification or qualifier |
|---|---|---|---|
| **VERIFIED** | the sampled store was busy: 1,363 maintenance events were done, 389 failed, and 190 proposals were pending. | amp’s verified runtime snapshot; the persisted event model is defined in [`events.ts`](modules/pi/packages/core/agent-memory/events.ts#L24-L73). | a fresh snapshot may change the counts. the counts describe activity and backlog, not benefit. |
| **VERIFIED** | all 392 sampled reviews were accepted: 391 automated or skill-originated and one local; none were rejected or rolled back. | amp’s verified runtime snapshot; review outcomes support accepted, edited, rejected, and rolled-back states in [`schema.ts`](modules/pi/packages/core/agent-memory/schema.ts#L125-L160). | a later rejection or rollback would change the distribution, but would not retroactively validate prior automated decisions. |
| **VERIFIED** | proposal and event volume is not evidence of useful retrieval. | the evaluation sample contained no cases, paired replays, or retrieval labels, while review and event counts were nonzero. | measured task uplift or retrieval labels correlated with outcomes would provide value evidence. |

### integrity

| status | claim | evidence | falsification or qualifier |
|---|---|---|---|
| **VERIFIED** | projection currently performs stable-read, jsonl, identity, graph, dangling-parent, and cycle checks before rendering. | [`parseStableSnapshot`](modules/pi/packages/core/agent-memory/index.ts#L291-L381) validates the source and graph; projection quarantines failures in [`index.ts`](modules/pi/packages/core/agent-memory/index.ts#L640-L696). | these checks establish validation behavior, not that every historical artifact is valid or that repeated global validation is necessary. |
| **VERIFIED** | recursive maintainer wake from audited model sessions was ruled out. | audited model invocations pass `--no-extensions` in [`audit.ts`](modules/pi/packages/core/agent-memory/audit.ts#L271-L280). | another model invocation path that enables extensions would disprove the broader claim; none was established in this investigation. |
| **VERIFIED** | the observed multi-gibibyte rss does not prove a permanent memory leak. | the hot process exited, and `vmmap` showed large bun/jsc mappings with a materially lower current physical footprint than process rss. | retained growth across repeated completed cycles in one surviving process, supported by heap or allocation evidence, would establish a leak. this investigation did not observe that. |
| **VERIFIED** | the model emits proposals, but current maintenance may immediately accept them and mutate canonical memory. | consolidation, deterministic maintenance, and corpus maintenance call `applyMemoryProposal` in [`index.ts`](modules/pi/packages/core/agent-memory/index.ts#L1688-L1722), [`index.ts`](modules/pi/packages/core/agent-memory/index.ts#L1915-L1945), and [`index.ts`](modules/pi/packages/core/agent-memory/index.ts#L3070-L3102); autonomous application delegates to review acceptance in [`workflow.ts`](modules/pi/packages/core/agent-memory/workflow.ts#L2004-L2035). | removing every maintenance bypass around branch preparation and remote merge would disprove the current-behavior claim. |
| **VERIFIED** | current transaction application already validates local base content and records transaction/history state, so the missing invariant is cross-host serialization rather than absence of local CAS. | source hashes are checked during transaction application in [`workflow.ts`](modules/pi/packages/core/agent-memory/workflow.ts#L1640-L1708), and transaction/history commit ordering is implemented in [`workflow.ts`](modules/pi/packages/core/agent-memory/workflow.ts#L1790-L2001). | a cross-host lock or remote-before-worktree CAS in the current path would qualify the diagnosis; none was found. |
| **VERIFIED** | canonical markdown is Syncthing-shared while proposals, reviews, transactions, workflow artifacts, and the Git object store are host-local. | configuration places canonical memory under `~/commonplace/01_files/_utilities/agent-memories` and workflow data under `~/.local/share/pi-memory` in [`index.ts`](modules/pi/packages/core/agent-memory/index.ts#L215-L235); workflow paths are host-local in [`workflow.ts`](modules/pi/packages/core/agent-memory/workflow.ts#L105-L170). | configuring those local directories onto a shared coordination filesystem would alter the topology; the inspected defaults do not. |
| **VERIFIED** | Git history is already shared through `origin/main`, but current synchronization rejects divergence instead of serializing a mutation before canonical files change. | fetch, ancestry checks, fast-forward, and push behavior are in [`history.ts`](modules/pi/packages/core/agent-memory/history.ts#L1244-L1273) and [`history.ts`](modules/pi/packages/core/agent-memory/history.ts#L1298-L1338); the remote is configured in [`default.nix`](modules/pi-memory/default.nix#L7-L20). | a remote CAS performed before local canonical publication would disprove this sequencing claim. |
| **VERIFIED** | Syncthing is currently a competing cross-host writer for canonical memory, and its generic conflict handler is not an agent-memory serialization protocol. | the `commonplace` folder is `sendreceive` with trashcan versioning in [`lib.nix`](modules/syncthing/lib.nix#L209-L266); generic three-way merge and quarantine behavior is in [`syncthing-automerge.ts`](modules/syncthing/automerge/syncthing-automerge.ts#L187-L365). | excluding the complete canonical memory subtree on every peer removes this competing authority. |
| **VERIFIED** | ordinary filesystem metadata plus a bounded boundary hash can establish continuity near the accepted cursor, but cannot prove that every earlier byte remained unchanged. | the append design reads only the saved boundary range and new bytes; proving the complete historical prefix would require a producer-supplied digest, filesystem generation identity, or full reread. | a trusted producer that rewrites earlier accepted bytes without changing the checked boundary would falsify any stronger immutability claim. |

**target policy — decided:** configured trusted pi and amp session producers may use the bounded continuity append fast path. this trust applies only to producer append behavior; every new record still receives schema, identity, parent, duplicate, and graph checks. all other source policies use complete streaming validation.

### operational health

| status | claim | evidence | falsification or qualifier |
|---|---|---|---|
| **VERIFIED** | every `maintain` performs full projection before gated work. | [`maintainUnlockedObserved`](modules/pi/packages/core/agent-memory/index.ts#L3003-L3017) calls `projectUnlocked` unconditionally. | a code path that skips projection based on a durable source revision would disprove this; none exists in the inspected path. |
| **VERIFIED** | recursive discovery accepts every jsonl beneath configured roots without backup, conflict, or unchanged-source exclusions. | [`walkJsonl`](modules/pi/packages/core/agent-memory/index.ts#L280-L288) recursively includes every regular `*.jsonl` file. | exclusions in configuration before this function would qualify the claim; the inspected projection call passes complete configured roots. |
| **VERIFIED** | approximately 1,874 files and 2.31 gibibytes were reread, parsed, graph-validated, rendered, and rewritten during full projection. the observed phase took 69.61 seconds. | source parsing is in [`index.ts`](modules/pi/packages/core/agent-memory/index.ts#L291-L381); every discovered source is rendered and atomically written in [`index.ts`](modules/pi/packages/core/agent-memory/index.ts#L625-L698). | a different corpus changes the absolute time and bytes, not the whole-corpus complexity. |
| **VERIFIED** | no-op transaction recovery reparses proposals multiplicatively. | recovery iterates every transaction and calls `findProposal` for each applied transaction in [`workflow.ts`](modules/pi/packages/core/agent-memory/workflow.ts#L1545-L1572); `findProposal` reparses both proposal directories in [`workflow.ts`](modules/pi/packages/core/agent-memory/workflow.ts#L199-L224). | a direct proposal index or recovery restricted to nonterminal transactions would remove this path. |
| **VERIFIED** | the sampled no-op recovery performed at least 228,144 proposal parses to recover zero transactions and took 57.68 seconds. | 392 applied transactions multiplied by 582 proposal files, following the traced call path above. | parser caching could reduce parsing without changing scans; terminal-state partitioning and direct lookup remove the multiplicative work. |
| **VERIFIED** | consolidation examines every autonomous pending proposal before applying the requested window limit. | [`consolidateV2UnlockedObserved`](modules/pi/packages/core/agent-memory/index.ts#L1685-L1732) preflights autonomous proposals before `pendingWindows(limit)`. | moving autonomy checks to proposal creation, indexed transition, or selected proposal reconciliation would remove the global preflight. |
| **VERIFIED** | each autonomy check rereads run artifacts and globally searches proposals. | [`reflectionAutonomyState`](modules/pi/packages/core/agent-memory/pipeline.ts#L1503-L1564) rereads input, output, result, critic input, critic output, and calls `findProposal`. | a durable validated autonomy decision bound to artifact digests and a direct proposal reference would remove this repeated reconstruction. |
| **VERIFIED** | the sampled consolidation performed at least 182,166 proposal parses plus about 59 mibibytes of run-input reads before one pending window. the phase took 71.78 seconds; the model consumed 7.88 seconds and failed. | traced preflight and proposal lookup behavior above, combined with amp’s runtime counts. | different backlog sizes change the totals. the measurement still shows orchestration dominating that run. |
| **VERIFIED** | `pendingWindows` reparses queued source snapshots and rescans the memory catalog per selected window. | source snapshots are parsed in [`index.ts`](modules/pi/packages/core/agent-memory/index.ts#L1304-L1390); catalog scanning occurs while each window is built in [`index.ts`](modules/pi/packages/core/agent-memory/index.ts#L1443-L1492). | a persisted source graph and immutable catalog snapshot reference would remove these repeated scans. |
| **VERIFIED** | recovery, projection, catalog publication, adaptation, reflection, corpus maintenance, qmd, reconciliation, and git synchronization share one maintenance invocation and broad lock. | the phase sequence is in [`index.ts`](modules/pi/packages/core/agent-memory/index.ts#L3003-L3146); `maintain` wraps it with `lock` in [`index.ts`](modules/pi/packages/core/agent-memory/index.ts#L3295-L3313). | independently claimable records and short commit locks would disprove the architectural coupling. |
| **VERIFIED** | the sampled broad lock was held for 210.53 seconds at about 97% cpu. | amp’s runtime trace; lock duration is emitted by [`index.ts`](modules/pi/packages/core/agent-memory/index.ts#L613-L621). | machine load affects timing, but not the fact that unrelated work shares the critical section. |
| **VERIFIED** | trigger coalescing is process-local rather than global. | the extension keeps local `maintenanceWake` and debounce state before detaching `maintain` in [`extensions/agent-memory/index.ts`](modules/pi/packages/extensions/agent-memory/index.ts#L1403-L1427) and [`extensions/agent-memory/index.ts`](modules/pi/packages/extensions/agent-memory/index.ts#L1480-L1513); launchd independently runs at load, hourly, and on wake paths in [`default.nix`](modules/pi-memory/default.nix#L27-L43); tier continuation writes wake and detaches another process in [`index.ts`](modules/pi/packages/core/agent-memory/index.ts#L3202-L3237). | the existing mutation lock serializes execution but does not merge trigger causes or prevent redundant contenders. |
| **VERIFIED** | maintenance events lack delayed retry, retained typed failure, expiry, priority, and opaque phase continuation. | the durable shape contains kind, basis, attempt, owner, claim time, and token, with only pending, processing, done, and failed states in [`events.ts`](modules/pi/packages/core/agent-memory/events.ts#L24-L73); retry simply returns a claimed event to pending in [`events.ts`](modules/pi/packages/core/agent-memory/events.ts#L451-L583). | another durable record carrying these fields would qualify the claim; none was found in this event path. |
| **VERIFIED** | pi already writes bounded, redacted JSONL wide events with durable interrupted-operation markers, but Darwin’s collector does not tail their default directory, so they do not currently reach Axiom. | the default path and local drain are in [`log/index.ts`](modules/pi/packages/core/log/index.ts#L91-L113), [`log/index.ts`](modules/pi/packages/core/log/index.ts#L418-L515), and [`log/index.ts`](modules/pi/packages/core/log/index.ts#L552-L665); agent-memory uses that wide-event boundary in [`observability.ts`](modules/pi/packages/core/agent-memory/observability.ts#L19-L158); Darwin tails `~/Library/Logs` in [`o11y/default.nix`](modules/o11y/default.nix#L16-L39) and its receiver/export pipeline is defined later in that module. | a dedicated JSON file receiver for `~/.local/state/pi/logs/*.jsonl` with an end-to-end Axiom canary would close this gap. |
| **HUNCH** | stale logger-marker recovery may add avoidable startup cost. | when stale markers exist, [`terminalOperationIds`](modules/pi/packages/core/log/index.ts#L316-L328) reads every historical jsonl log before [`reconcileInterrupted`](modules/pi/packages/core/log/index.ts#L357-L415) processes markers. | proving that stale markers are absent, promptly removed, or a negligible share of runtime would remove this concern. the marker lifetime and cost remain unmeasured, and this is secondary to the traced maintainer loops. |

### retrieval diagnostics

| status | claim | evidence | falsification or qualifier |
|---|---|---|---|
| **VERIFIED** | the sampled evaluation store had zero cases, zero paired memory-on/off replays, and zero retrieval labels. | amp’s verified runtime inspection. paired replay and retrieval metrics already exist as capabilities in [`evaluation.ts`](modules/pi/packages/core/agent-memory/evaluation.ts#L1175-L1214) and [`evaluation.ts`](modules/pi/packages/core/agent-memory/evaluation.ts#L1373-L1435), but had no sampled evidence. | populating, grading, and retaining representative cases would change the diagnostic evidence state. |
| **VERIFIED** | current acceptance history does not establish critic accuracy, memory correctness, or net retrieval benefit. | every sampled review was accepted and none was rolled back, leaving no negative examples or measured counterfactual. | blinded paired outcomes, retrieval labels, user corrections, and rollbacks tied to specific memory versions would provide discriminating diagnostic evidence. |
| **HUNCH** | memory may be useful in some sessions. | the investigation contained an anecdote that prior memory prevented duplicated heat investigation. | controlled replay or repeated labeled outcomes could establish attributable value. one anecdote cannot establish net benefit. |

retrieval usefulness is not the product admission criterion. memory is durable, evolving knowledge of what happened across agents. paired replay and retrieval labels remain useful for tuning retrieval, prompt budgets, ranking, and detecting harm, but they do not decide whether a safely represented, well-provenanced event belongs in canonical memory.

## complexity decision

| operation | current effective cost | target cost |
|---|---|---|
| no-change maintenance | whole session corpus plus historical transaction and backlog scans | constant demand reconciliation plus bounded metadata checks; zero source-content reads and zero projection writes |
| trusted append-only session update | full source parse plus global projection pass | appended bytes, bounded cursor continuity proof, direct parent/id checks, and affected branch fragments; no claim of whole-prefix revalidation |
| transaction recovery | all transactions multiplied by all proposals | incomplete transactions only, with direct proposal references |
| proposal lookup | parse every pending and reviewed proposal | deterministic indexed lookup by full id |
| reflection preflight | all autonomous pending proposals and their run artifacts | selected proposal or workflow record only |
| checkpoint selection | all queued jobs and repeated source/catalog reads | ready workflow index plus immutable source and catalog references |
| trigger storm | one local debounce per extension process plus timer and continuation launches | one durable host demand generation with merged reasons and bounded hints |
| retry | immediate pending/processing cycling without retained reason | durable delayed state with typed error, next eligible time, lease history, and expiry |
| model execution | inside broad maintenance lock | immutable prepare, unlocked invocation, and proposal persistence |
| proposal preparation | may lead directly to canonical mutation | isolated candidate tree/commit; usable checkout unchanged |
| cross-host merge | local mutation followed by Git push while Syncthing also replicates files | fetched remote basis, exact-path rebase, fast-forward compare-and-swap, then verified local materialization |
| remote outage | history synchronization failure after local mutation | merge workflow waits without a worker; canonical checkout and branch work remain usable |
| qmd publication | scans the canonical directory, including accidental conflict artifacts | verified local qmd-source projection containing only accepted catalog entries |

a bounded metadata discovery audit may still be proportional to the number of directory entries it inspects. it must use a durable cursor and page budget rather than execute before every work slice.

cross-host correctness must not depend on scanning for Syncthing conflicts after they occur. the transport boundary removes canonical memory from Syncthing, and the merge boundary prevents more than one accepted successor to a remote head.

## pattern-language basis

the authoritative source is the [`packages/pattern-language` readme](https://github.com/bdsqqq/igorbedesqui.com/blob/main/packages/pattern-language/README.md). the architecture uses the patterns as design constraints, not as a mandate for a database or framework.

| pattern | stated meaning | application here |
|---|---|---|
| [`workflow = data`](https://github.com/bdsqqq/igorbedesqui.com/blob/main/packages/pattern-language/workflow-equals-data.md) | a workflow is a persistent record with state, context, and awaited event rather than a running process. | every maintenance unit survives process exit as a schema-validated record. |
| [`exhaustive state modeling`](https://github.com/bdsqqq/igorbedesqui.com/blob/main/packages/pattern-language/exhaustive-state-modeling.md) | typed states, events, and transitions should make unhandled paths and impossible combinations visible. | workflow state is a discriminated union; retry, waiting, failure, expiry, and completion are distinct shapes. |
| [`independently invocable units`](https://github.com/bdsqqq/igorbedesqui.com/blob/main/packages/pattern-language/independently-invocable-units.md) | significant boundaries should run as ordinary functions, cli units, or fixtures without their host. | source, transaction, proposal, reflection, indexing, and health reconcilers each accept explicit dependencies and ids. |
| [`reconcile to desired state`](https://github.com/bdsqqq/igorbedesqui.com/blob/main/packages/pattern-language/reconcile-to-desired-state.md) | deterministic reconciliation should inspect current reality and converge idempotently. | a rerun checks artifact digests, record revision, history head, and desired state before writing. |
| [`suspend without blocking`](https://github.com/bdsqqq/igorbedesqui.com/blob/main/packages/pattern-language/suspend-without-blocking.md) | suspension and crash recovery are separate mechanisms; waiting must not retain a worker. | delayed retry and model waiting persist state, release locks, and let the process exit. |
| [`self-expiring state`](https://github.com/bdsqqq/igorbedesqui.com/blob/main/packages/pattern-language/self-expiring-state.md) | lifecycle resources carry their own expiry and timeout consequence. | leases, waits, retries, pending proposals, terminal workflow evidence, model artifacts, local projections, and telemetry declare lifecycle or cleanup policy directly. accepted Git history, canonical memory versions, history-verification receipts, accepted admission summaries, and canonical-evidence capsules are explicitly outside self-expiring state. |
| [`context-rich events`](https://github.com/bdsqqq/igorbedesqui.com/blob/main/packages/pattern-language/context-rich-events.md) | one significant operation event should contain enough context to understand it independently; transport is orthogonal and dimensionality has cost. | every significant reconciliation or merge attempt emits one bounded event with identifiers, business state, basis, timing, resource use, and outcome. local JSONL and Axiom are transports; durable workflow records remain recovery authority. |
| [`inject at the boundary`](https://github.com/bdsqqq/igorbedesqui.com/blob/main/packages/pattern-language/inject-at-the-boundary.md) | domain logic should receive explicit adapters for external i/o. | filesystem, clock, id generation, locks, process execution, model invocation, history, and event emission are injected once at entrypoints. |
| [`carry, don’t interpret`](https://github.com/bdsqqq/igorbedesqui.com/blob/main/packages/pattern-language/carry-dont-interpret.md) | the orchestrator stores an opaque continuation that only its producing step interprets. | the dispatcher validates only the continuation envelope and size; each reconciler owns payload schema and migration. |
| [`errors as values`](https://github.com/bdsqqq/igorbedesqui.com/blob/main/packages/pattern-language/errors-as-values.md) | expected failures are typed results; exceptions are reserved for unexpected faults. | source instability, basis changes, contention, rate limits, timeouts, invalid output, and closed policy gates are explicit outcomes. |
| [`schema-derived types`](https://github.com/bdsqqq/igorbedesqui.com/blob/main/packages/pattern-language/schema-derived-types.md) | runtime schema and compile-time type should have one source of truth. | every file-backed record is validated at read time, and its types are inferred from the canonical schema. |
| [`human-friendly identifiers`](https://github.com/bdsqqq/igorbedesqui.com/blob/main/packages/pattern-language/human-friendly-identifiers.md) | ids should expose type and recency while remaining mechanically selectable and filesystem-safe. | workflow ids include kind, sortable utc creation time, and collision suffix; content identities retain digest-based ids where appropriate. |
| [`colocate by behavior`](https://github.com/bdsqqq/igorbedesqui.com/blob/main/packages/pattern-language/colocate-by-behavior.md) | types, logic, adapters, and tests should live with the behavior they implement. | demand, sources, projection, transactions, reflection, evaluation, and health own their schemas and reconcilers instead of feeding one larger `index.ts`. |

## target architecture

```diagram
┌──────────────────────── host a: local and durable ────────────────────────┐
│ demand + workflows ──▶ proposal ──▶ candidate commit                     │
│                                  (usable checkout unchanged)              │
│                                                                          │
│ verified canonical checkout ──▶ verified qmd-source ──▶ qmd index        │
│                                                                          │
│ significant operations ──▶ local redacted JSONL                         │
└──────────────────────────────┬──────────────────────────┬─────────────────┘
                               │ fast-forward CAS         │ collector tail
                               ▼                          ▼
                    ┌────────────────────┐       ┌────────────────┐
                    │ shared Git remote  │       │ OpenTelemetry  │
                    │   origin/main      │       │   collector    │
                    └─────────┬──────────┘       └───────┬────────┘
                              │                          │
                              │ accepted immutable       ▼
                              │ commits, receipts,  ┌──────────┐
                              │ + evidence          │  Axiom   │
                              │                     └──────────┘
                              ▼
┌──────────────────────── host b: local and durable ────────────────────────┐
│ verified fetch ──▶ canonical checkout ──▶ qmd-source ──▶ qmd index       │
│                                                                          │
│ demand + workflows ──▶ proposal ──▶ candidate commit ──▶ remote CAS      │
│ significant operations ──▶ local redacted JSONL ──▶ collector            │
└──────────────────────────────────────────────────────────────────────────┘
```

the target separates canonical knowledge and audit evidence, recoverable local work, expendable source material, rebuildable state, and telemetry. retention in one class never implies retention in another:

| class | authority | retention and recovery semantics |
|---|---|---|
| shared canonical knowledge and audit evidence | accepted commit objects reachable from `origin/main`, including canonical markdown, mutation receipts, accepted admission summaries, and canonical-evidence capsules | shared across hosts and retained indefinitely; capsule paths are immutable and append-only, and every historical memory version remains available after compensating correction |
| recoverable host-local work | nonterminal workflows, pending or blocked proposals, candidate refs, model invocations, and every artifact they reference | host-local recovery authority; never removed while nonterminal, mergeable, blocked awaiting action, or referenced by retained work |
| external source inputs | raw session files under configured pi and amp roots | producer-owned inputs; the maintainer never deletes them. if a producer later expires a source, accepted auditability survives through the canonical capsule rather than a dead source reference |
| expendable host-local preparation and finished evidence | copied source snapshots, prompts, complete model and tool outputs, terminal workflows, expired-proposal summaries, replay evidence, and other unreferenced diagnostic artifacts | not canonical; eligible for measured cleanup only after reference tracing proves that active work no longer depends on them and every accepted dependent claim has a valid capsule in accepted Git history |
| derived local state | verified checkout, catalog, session projections, qmd-source mirror, qmd index, direct indexes, and receipt caches | rebuildable from remaining source inputs or accepted Git history; may be replaced or removed after its basis is verified |
| local jsonl telemetry transport | bounded redacted operation events and interrupted-operation markers under `~/.local/state/pi/logs` | temporary host-local delivery buffer; acknowledged rotations are removed first, a hard byte cap prevents disk growth, and dropped telemetry becomes an explicit health signal rather than blocking domain work |
| Axiom runtime telemetry | bounded pi operation events exported by the collector | diagnostic and queryable only; the pi stream never contains canonical evidence and never affects workflow recovery, admission, or canonical retention |

### canonical serialization and branch contract

#### branch preparation

every proposal binds to:

- proposal id and immutable proposal digest;
- source-evidence and catalog digests;
- prompt, model, source-policy, and admission-policy versions;
- observed `origin/main` commit;
- every touched path’s expected before state, including expected absence;
- exact desired after content and digest;
- actor, reviewer or automatic-admission identity, and expiry.

preparation uses a private index, temporary worktree, or equivalent host-local Git plumbing. it must not edit the canonical checkout. the prepared commit or tree is retained by proposal id so a crash or offline interval does not lose work.

#### canonical evidence capsule

a merge-ready admission produces one canonical-evidence capsule before candidate-commit construction. the capsule is stored relative to the canonical memory root at:

```text
.pi-memory/evidence/sha256/<prefix>/<capsule-sha256>.json
```

its bytes enter the same candidate tree as the memory mutation. the mutation receipt binds the capsule path and digest. capsule paths are immutable, append-only, retained in descendant trees, and hard-excluded from the catalog, qmd-source, qmd indexing, prompt injection, and telemetry.

a durable claim is not inferred later from free-form markdown. the proposal declares a stable claim id, epistemic classification, exact target path, and exact utf-8 byte span and digest in the rendered after-content. admission verifies that these spans cover every added or materially changed non-structural assertion. structural syntax and metadata are validated separately; uncovered asserted bytes close merge readiness.

each capsule contains only bounded canonical json sufficient to audit the accepted claims:

- schema version, mutation id, proposal digest, affected memory paths, and exact before and after digests;
- admission decision id, timestamp, actor or automatic-admission identity, policy version, and bounded outcomes for every admission check;
- safe source descriptors: source kind, stable agent/session identity, observation time, normalized workspace or scope, and bounded source locator;
- evidence entries classified as user statement, tool observation, external-source statement, or model inference;
- for each entry, `exact-excerpt`, `redacted-excerpt`, or `structured-observation`, its retained safe bytes, digest, epistemic classification, and safety-transformation version;
- a mapping from each added or materially changed claim digest to one or more evidence-entry ids;
- the original artifact digest only when retaining that digest passes safety policy. it is lineage metadata and never substitutes for retained claim-bearing bytes.

entry count, entry size, total capsule size, and locator size are finite policy limits. evidence must not be silently truncated past material qualifiers or contradictory context. if sufficient support does not fit, the proposal must be split or narrowed rather than admitted.

secret values, reversible ciphertext, secret-derived low-entropy fingerprints, raw prompts, complete memory bodies, complete sessions, complete model outputs, and unbounded transcripts are forbidden in capsules. typed redaction markers may replace sensitive spans only when the remaining evidence still supports the claim. a claim that cannot retain safe sufficient evidence is not merge-ready; manual review may rewrite it into a less specific supportable claim but may not bypass this rule.

#### merge readiness

a proposal is merge-ready only when:

1. it is unexpired and schema-valid;
2. every durable claim has acceptable provenance and epistemic classification;
3. secret, safety, path, size, graph, and structural checks pass;
4. a manual or automatic admission decision is bound to the exact proposal digest and policy version;
5. a bounded canonical-evidence capsule passes safety checks and maps every added or materially changed durable claim to retained supporting evidence;
6. the desired patch is deterministic and idempotent;
7. its current rebase has no changed-target conflict.

model output alone never grants merge readiness. deterministic maintenance, reflection, corpus-doctor, tiering, migration, and skill paths use the same admission and merge boundary.

#### compare-and-swap, rebase, and conflict behavior

the merge reconciler:

1. fetches and verifies `origin/main`;
2. searches accepted history for the proposal or mutation id; if already present, it records idempotent success;
3. compares each touched path in the fetched tree with the proposal’s expected before and desired after digests;
4. treats a path already at the desired digest as satisfied;
5. reapplies the exact proposal to the fetched head when every remaining touched path still matches its expected before state;
6. blocks with `basis-changed` when a touched path has any third value;
7. validates the complete candidate tree, claim-to-evidence mapping, canonical-evidence capsule, accepted admission summary, and receipt, including exact capsule path and digest binding;
8. creates a single-parent commit whose parent is the fetched remote head;
9. performs a normal fast-forward-only push to `origin/main`;
10. retries from step 1 after a non-fast-forward race, subject to the workflow retry budget;
11. only after remote acceptance, advances the local main ref and canonical checkout under a short local checkout lock;
12. republishes the catalog and qmd-source only after checkout verification succeeds.

the reconciler does not use force push, last-write-wins, or generic textual merge for a changed target path. edits to unrelated paths rebase automatically because their path preconditions remain true. a changed target retains the proposal and evidence, becomes `blocked`, and requires regeneration or an explicitly reviewed replacement proposal.

if the push result is lost, the next attempt fetches and searches immutable receipts before creating another commit. rollback is a new compensating proposal and commit; accepted history is never rewritten.

#### offline behavior

while the remote is unavailable:

- the last verified canonical checkout remains readable;
- source projection, proposal generation, review, and candidate preparation may continue;
- merge workflows enter `waiting` or delayed retry without holding a worker;
- status reports the last verified remote head and its age;
- no local result is described as globally merged.

### behavior-owned modules

the exact filenames may follow nearby repository conventions, but ownership must remain vertical:

| behavior | owns | independently invocable contract |
|---|---|---|
| `maintainer/demand` | host-local demand schema, short lock, merge rules, and wake lifecycle | `request(demand)` and `dispatchSlice(budget)` |
| `maintainer/workflows` | record envelope, transitions, leases, storage, and duplicate recovery | `claim(criteria)`, `transition(id, event)`, and `reconcileRecord(id)` |
| `maintainer/sources` | root policy, source identity, metadata revision, discovery cursor, missing/replacement state | `reconcileSource(sourceId)` and `discoverRoot(rootId, budget)` |
| `maintainer/projection` | append parsing, normalized graph indexes, branch fragments, checkpoint publication, and qmd-source publication | `projectRevision(sourceId, revision)` and `publishQmdSource(head)` |
| `maintainer/catalog` | incremental memory/skill registry and immutable catalog manifests | `reconcileCatalogSource(sourceId)` and `publishCatalog(basis)` |
| `maintainer/transactions` | branch-local transaction construction, base-content checks, and receipts | `prepareTransaction(transactionId, head)` |
| `maintainer/proposals` | direct id index, review state, expiry, and admission-decision reference | `reconcileProposal(proposalId)` |
| `maintainer/admission` | provenance, epistemic, safety, structural, and convergence policy plus canonical-evidence capsule construction | `evaluateAdmission(proposalId, policyVersion)` |
| `maintainer/history` | candidate commits, immutable mutation receipts and capsule bindings, verified fetch, fast-forward CAS, and checkout materialization | `prepareCommit(proposalId)`, `mergeCommit(proposalId)`, and `materialize(head)` |
| `maintainer/reflection` | prepared input, model invocation, critic result, and stale-basis handling | `prepare`, `invoke`, and `persistProposal` by workflow id |
| `maintainer/evaluation` | frozen cases, paired replay, retrieval labels, grades, and diagnostic reports | `replay(caseId, arm)` and `evaluateRetrieval(datasetId)` |
| `maintainer/health` | authority, convergence, integrity, activity, operational, diagnostic, local-cleanup, and telemetry summaries | `buildHealth(asOf)` |
| `maintainer/integrations` | cli, launchd/systemd, extension request adapter, qmd, Git, model, and event transport adapters | boundary-specific commands with no domain state |

shared code should be limited to schema primitives, canonical hashing, safe paths, atomic durable writes, and narrow adapter contracts.

### file-backed layout

```text
~/.local/share/pi-memory/v3/                 # host-local durable data
  workflows/
    ready/
    leased/
    waiting/
    retry-scheduled/
    blocked/
    succeeded/
    failed/
    cancelled/
    expired/
  sources/
    records/<shard>/<source-id>.json
    entries/<source-id>/<shard>/<entry-id>.json
    leaves/<source-id>.json
    checkpoints/<source-id>/<checkpoint-id>.json
  indexes/
    proposals/<shard>/<proposal-id>.json
    transactions/nonterminal/<transaction-id>.json
    accepted-receipts/<shard>/<mutation-id>.json
  proposals/
    pending/<shard>/<proposal-id>.json
    reviewed/<shard>/<proposal-id>.json
    expired/<shard>/<proposal-id>.json
  admissions/<shard>/<decision-id>.json
  artifacts/sha256/<prefix>/<digest>
  history.git/                               # fetched commits + host-local proposal refs
  projections/
    qmd-source/<canonical-relative-path>.md  # verified allowlist only
    qmd-source-manifest.json

~/.local/state/pi-memory/v3/                 # host-local mutable runtime state
  demand/
    current.json
    wake
  checkout/
    current.json                             # verified local/remote heads and age
  observations/
    <date>.jsonl
  health/
    latest.json

~/.local/state/pi/logs/                      # existing local telemetry transport
  <rotation>.jsonl
  pending/<operation-marker>.json

~/commonplace/01_files/_utilities/agent-memories/
  <canonical markdown paths>                 # verified checkout of accepted main
  .pi-memory/evidence/sha256/<prefix>/<digest>.json
                                             # canonical audit evidence; never qmd input
  .qmd/                                      # local derived qmd state if retained

origin/main                                  # sole shared mutable authority
  commit N
    canonical markdown tree
    .pi-memory/evidence/sha256/<prefix>/<digest>.json
    Pi-Memory-Receipt trailer binding mutation, admission, and capsule
  commit N+1
    canonical markdown tree
    prior append-only evidence capsules
    .pi-memory/evidence/sha256/<prefix>/<new-digest>.json
    Pi-Memory-Receipt trailer binding mutation, admission, and capsule
```

everything below `~/.local/share/pi-memory`, `~/.local/state/pi-memory`, and `~/.local/state/pi/logs` is host-local and must not be added to Syncthing. the canonical memory root remains at its existing extension-facing path but the entire subtree is ignored by Syncthing on every peer and is populated only from verified Git history.

workflow state directories are selection indexes as well as human-readable state. a transition writes and fsyncs the next revision before removing the prior revision. if a process dies between those operations, bounded lookup across known state directories chooses the highest record revision and reconciles the older copy. equal revisions with different digests are corruption and become `blocked`, never last-write-wins.

content-addressed artifacts and accepted Git commits are immutable. mutable workflow records reference their digests. local canonical and qmd projections are reproducible and may be replaced only after their source head or manifest verifies.

## durable workflow model

the schema notation below is normative in shape but implementation-neutral. it does not justify adding a validation dependency by itself. the implementation should extend the repository’s existing validation style or adopt a schema library only through a separate dependency decision.

```ts
const WorkflowRecordSchema = schema.object({
  schemaVersion: schema.literal(3),
  id: WorkflowIdSchema,
  revision: schema.safeInteger({ min: 1 }),
  kind: schema.enum([
    "source-reconcile",
    "projection-reconcile",
    "transaction-reconcile",
    "proposal-reconcile",
    "reflection",
    "corpus-maintenance",
    "evaluation",
    "qmd-index",
    "history-sync",
    "retention",
  ]),
  priority: schema.enum(["integrity", "interactive", "normal", "background"]),
  demandGeneration: schema.safeInteger({ min: 1 }),
  basis: BasisSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  attempt: schema.safeInteger({ min: 0 }),
  state: schema.discriminatedUnion("type", [
    schema.object({
      type: schema.literal("ready"),
      step: StepSchema,
      availableAt: TimestampSchema,
      continuation: ContinuationEnvelopeSchema.nullable(),
    }),
    schema.object({
      type: schema.literal("leased"),
      step: StepSchema,
      lease: LeaseSchema,
      continuation: ContinuationEnvelopeSchema.nullable(),
    }),
    schema.object({
      type: schema.literal("waiting"),
      step: StepSchema,
      wait: schema.discriminatedUnion("type", [
        schema.object({
          type: schema.literal("timer"),
          resumeAt: TimestampSchema,
        }),
        schema.object({
          type: schema.literal("model-output"),
          invocationId: ModelInvocationIdSchema,
          preparedArtifact: ArtifactRefSchema,
          timeoutAt: TimestampSchema,
        }),
        schema.object({
          type: schema.literal("external-process"),
          invocationId: ExternalInvocationIdSchema,
          expectedArtifact: ArtifactRefSchema,
          timeoutAt: TimestampSchema,
        }),
      ]),
      continuation: ContinuationEnvelopeSchema,
      expiresAt: TimestampSchema,
    }),
    schema.object({
      type: schema.literal("retry-scheduled"),
      step: StepSchema,
      nextAttemptAt: TimestampSchema,
      expiresAt: TimestampSchema,
      error: ExpectedFailureSchema,
      continuation: ContinuationEnvelopeSchema.nullable(),
    }),
    schema.object({
      type: schema.literal("blocked"),
      step: StepSchema,
      blockedAt: TimestampSchema,
      reviewBy: TimestampSchema,
      expiresAt: TimestampSchema,
      error: FailureSchema,
      continuation: ContinuationEnvelopeSchema.nullable(),
    }),
    schema.object({
      type: schema.literal("succeeded"),
      completedAt: TimestampSchema,
      outputs: schema.array(ArtifactRefSchema),
      retainUntil: TimestampSchema,
    }),
    schema.object({
      type: schema.literal("failed"),
      failedAt: TimestampSchema,
      error: FailureSchema,
      retainUntil: TimestampSchema,
    }),
    schema.object({
      type: schema.literal("cancelled"),
      cancelledAt: TimestampSchema,
      reason: CancellationReasonSchema,
      retainUntil: TimestampSchema,
    }),
    schema.object({
      type: schema.literal("expired"),
      expiredAt: TimestampSchema,
      priorState: schema.enum(["waiting", "retry-scheduled", "blocked"]),
      reason: ExpiryReasonSchema,
      retainUntil: TimestampSchema,
    }),
  ]),
});

type WorkflowRecord = Infer<typeof WorkflowRecordSchema>;
```

there must be no record with independent optional flags such as `failed`, `complete`, `retrying`, or `paused`. state-specific data belongs only to the matching variant.

### leases

```ts
const LeaseSchema = schema.object({
  token: ClaimTokenSchema,
  owner: ProcessIdentitySchema,
  claimedAt: TimestampSchema,
  expiresAt: TimestampSchema,
});
```

a lease grants permission to propose one state transition; it does not grant an indefinite mutation lock. completion requires the current record revision and lease token. an expired lease transitions back to `ready` or `retry-scheduled` according to policy, retaining the interrupted attempt.

### opaque continuation

```ts
const ContinuationEnvelopeSchema = schema.object({
  ownerStep: StepSchema,
  version: schema.safeInteger({ min: 1 }),
  payload: JsonValueSchema,
  payloadSha256: Sha256Schema,
});
```

the workflow store validates the envelope, digest, and configured size limit. it must not inspect, normalize, merge, or migrate `payload`. only `ownerStep` may interpret it.

### expected failures as values

```ts
const ExpectedFailureSchema = schema.discriminatedUnion("code", [
  SourceMissingFailureSchema,
  SourceUnstableFailureSchema,
  SourceInvalidFailureSchema,
  SourceReplacedFailureSchema,
  BasisChangedFailureSchema,
  LockContendedFailureSchema,
  ModelRateLimitedFailureSchema,
  ModelUnavailableFailureSchema,
  ModelTimedOutFailureSchema,
  ModelOutputInvalidFailureSchema,
  ExternalCommandFailureSchema,
  CanonicalAdmissionClosedFailureSchema,
]);

const FailureSchema = schema.union([
  ExpectedFailureSchema,
  schema.object({
    code: schema.literal("unexpected"),
    step: StepSchema,
    observedAt: TimestampSchema,
    summary: SafeBoundedStringSchema,
    fingerprint: Sha256Schema,
    evidence: schema.array(ArtifactRefSchema),
  }),
]);

type ExpectedFailure = Infer<typeof ExpectedFailureSchema>;
type Failure = Infer<typeof FailureSchema>;
```

reaching a configured finite work boundary at a valid checkpoint is not a failure. it produces a successful `suspended` step outcome, persists continuation, returns the workflow to `ready` with `availableAt`, leaves `attempt` unchanged, preserves demand, and releases the lease. it does not enter retry policy or increment failure health metrics.

an individual atomic item that cannot be processed within a hard safety bound is an input or policy failure, such as an oversized invalid source record; it must not be reported as ordinary work-boundary suspension.

each expected failure schema must retain:

- the failed step;
- the safe human-readable reason;
- relevant workflow, source, proposal, or invocation ids;
- whether and when policy allows retry;
- bounded artifact references needed for diagnosis;
- the basis revision against which it occurred.

raw thrown errors remain appropriate for programmer invariants. the process boundary captures them as `unexpected`, emits one failure event, and moves the workflow to `failed` or `blocked`; it must not silently return work to pending.

### transition contract

| current state | accepted event | next state |
|---|---|---|
| `ready` | valid claim | `leased` |
| `leased` | safe finite boundary reached | `ready` with persisted continuation and `availableAt`; operation outcome is `suspended`, attempt is unchanged |
| `leased` | deterministic step completed | `ready`, `waiting`, or `succeeded` |
| `leased` | retryable expected failure | `retry-scheduled` |
| `leased` | non-retryable expected failure | `blocked` or `failed` |
| `leased` | lease expired | `ready` or `retry-scheduled` with interrupted-attempt evidence |
| `waiting` | awaited artifact exists and validates | `ready` |
| `waiting` | timeout reached | `retry-scheduled`, `blocked`, or `expired` according to policy |
| `retry-scheduled` | `nextAttemptAt` reached | `ready` |
| `blocked` | operator or policy resolution | `ready`, `cancelled`, or `failed` |
| `waiting`, `retry-scheduled`, `blocked` | `expiresAt` reached | `expired` |
| any nonterminal state | explicit cancellation | `cancelled` |
| terminal state | its class-specific local retention deadline is reached and no retained record references it | compacted or removed by retention reconciliation; canonical Git history, receipts, admission summaries, and evidence capsules are unchanged |

transition matching must be exhaustive in TypeScript and runtime validation.

### identifiers

new workflow identifiers should be filesystem-safe and temporally sortable:

```text
wf_<kind>_<utc-compact>_<collision-suffix>
```

examples are documentation only:

```text
wf_source_20260903t142233123z_7k2m9d
wf_reflect_20260903t142241808z_h4q1nc
```

existing content-addressed proposal, event, review, and mutation ids should remain unchanged unless a migration requires otherwise.

## incremental source registry

### source identity and revision

a logical source is identified by:

- a configured `rootId`;
- its normalized relative path beneath that root;
- its declared source kind;
- its source-policy version.

absolute paths are boundary data and must not become portable identity.

```ts
const SourceRecordSchema = schema.object({
  schemaVersion: schema.literal(3),
  sourceId: SourceIdSchema,
  identity: schema.object({
    rootId: RootIdSchema,
    relativePath: SafeRelativePathSchema,
    kind: schema.enum([
      "pi-session-jsonl",
      "amp-session-jsonl",
      "memory-markdown",
      "skill-artifact",
    ]),
    policyVersion: schema.safeInteger({ min: 1 }),
  }),
  revision: schema.object({
    device: schema.string(),
    inode: schema.string(),
    size: schema.safeInteger({ min: 0 }),
    mtimeNs: schema.string(),
    ctimeNs: schema.string(),
  }),
  accepted: schema.object({
    byteCursor: schema.safeInteger({ min: 0 }),
    completeLineCount: schema.safeInteger({ min: 0 }),
    prefixDigest: Sha256Schema,
    boundaryProof: schema.object({
      start: schema.safeInteger({ min: 0 }),
      length: schema.safeInteger({ min: 0 }),
      sha256: Sha256Schema,
    }),
    entryFrontier: EntryIdSchema.nullable(),
    graphManifest: ArtifactRefSchema,
  }),
  projection: schema.object({
    sourceRevisionDigest: Sha256Schema,
    markdownSha256: Sha256Schema,
    stablePath: SafeRelativePathSchema,
    leafManifest: ArtifactRefSchema,
    checkpointFrontier: ArtifactRefSchema,
  }),
  state: schema.discriminatedUnion("type", [
    schema.object({ type: schema.literal("active") }),
    schema.object({
      type: schema.literal("missing"),
      firstObservedAt: TimestampSchema,
      expiresAt: TimestampSchema,
    }),
    schema.object({
      type: schema.literal("quarantined"),
      error: FailureSchema,
      reviewAfter: TimestampSchema,
    }),
  ]),
});

type SourceRecord = Infer<typeof SourceRecordSchema>;
```

### discovery and policy

discovery must be declarative:

1. only configured native pi session roots and the explicit amp ingress root are eligible by default;
2. `.stversions`, every path segment named `.stversions`, and every basename matching `*.sync-conflict-*` are rejected before source registration;
3. backup, snapshot, quarantine, generated, and historical-copy roots require an explicit source-kind opt-in;
4. extension and ingress boundaries submit changed-path hints when known;
5. filesystem watch events are hints, never the source of truth;
6. periodic discovery uses a durable root cursor and bounded page size;
7. hint overflow collapses to one `root-scan-needed` demand rather than an unbounded path list.

qmd does not scan the Syncthing-visible tree directly. the `agent-memories` collection points to the generated `projections/qmd-source` mirror, which contains only catalog-verified markdown from the accepted canonical head. publication rejects `.stversions`, `*.sync-conflict-*`, untracked files, proposal branches, and paths absent from the accepted catalog. these exclusions are hard invariants even if future collection patterns or source roots broaden.

the reserved `.pi-memory/**` subtree is never a catalog entry, qmd-source document, retrieval result, or prompt input even though its files are canonical Git audit evidence.

the canonical memory subtree itself is excluded from Syncthing on every peer. conflict files are treated as migration and integrity incidents to remove, not alternate memory sources.

### unchanged fast path

for a registered source:

1. stat the expected path;
2. compare identity and revision metadata;
3. if the tuple is identical, stop.

**unchanged means no source-content read, no source-record rewrite, no projection rewrite, and no checkpoint-job rewrite.** recording that the dispatcher examined the source belongs in an operation event, not in the source record.

### trusted append fast path

the append fast path is allowed only when the source policy identifies a configured trusted session producer whose contract is append-only. trust here means the producer does not rewrite accepted historical bytes; it does not bypass validation of new content.

an append candidate requires:

- the same logical identity;
- the same filesystem identity;
- a larger size;
- a configured trusted producer and allowlisted append-only source kind;
- a matching hash of the bounded byte range immediately before the accepted cursor;
- a valid complete-jsonl continuation.

the reconciler then:

1. reads the boundary-proof range and bytes after `byteCursor`;
2. preserves an incomplete trailing line in the step-owned continuation;
3. validates every new record against the session header and direct accepted-entry index;
4. rejects duplicate ids and parents absent from either the accepted index or current append;
5. updates affected leaf and checkpoint indexes;
6. derives affected projection fragments from cached parent and summary state;
7. assembles the bounded stable projection;
8. publishes idempotent checkpoint workflows;
9. commits the new source record last.

this path guarantees that the checked cursor boundary still matches, newly appended records validate, references resolve against the accepted graph or current append, and publication remains crash-safe and idempotent. it does not reread or cryptographically prove the entire accepted prefix, so it does not guarantee immediate detection of an arbitrary earlier edit that leaves filesystem identity and the checked boundary compatible.

### truncation, replacement, mutation, and untrusted-source fallback

perform a complete stable streaming parse when any of these occurs:

- size decreases;
- filesystem identity changes;
- metadata changes without size growth;
- the cursor boundary proof fails;
- the producer or source kind is not configured as trusted append-only;
- appended records invalidate graph assumptions;
- the accepted source schema or source policy version changes;
- any other evidence is incompatible with a pure append.

the fallback validates the complete source while streaming, builds a new content-addressed graph manifest and projection, and replaces the accepted source record only after the complete candidate validates. an unstable or invalid source is quarantined. replacement with a conflicting session identity remains quarantined rather than silently superseding an existing source.

missing files transition to `missing`; they are not immediately forgotten. the source-owned expiry policy determines when projections and indexes are withdrawn.

### projection and catalog frontiers

the registry must retain enough derived state to avoid reparsing source history:

- direct entry-id records or a sharded equivalent;
- parent existence and current leaf membership;
- latest accepted summary and checkpoint per affected branch;
- rendered branch-fragment digests;
- checkpoint workflow ids already published;
- source revision used by the stable markdown projection;
- immutable catalog manifest digest used by reflection or observation processing.

memory and skill artifacts use the same revision principle. a changed memory updates one catalog entry and publishes a new immutable catalog manifest. selected workflows carry that manifest digest rather than calling `scanCatalog` independently.

### crash ordering and idempotence

each source reconciliation uses this order:

1. claim the workflow by record revision and lease token;
2. read and validate input within the slice budget;
3. write immutable graph, fragment, projection, and checkpoint artifacts;
4. fsync artifacts and containing directories;
5. create checkpoint workflows with deterministic ids derived from source identity, accepted revision, and checkpoint id;
6. publish the changed stable projection only when its digest differs;
7. atomically write and fsync the new source record;
8. complete the workflow;
9. remove superseded mutable files only through later retention reconciliation.

a crash before step 7 leaves unreferenced immutable artifacts that retention may collect. a crash after step 7 is recoverable from the source record. deterministic workflow ids prevent duplicate checkpoint work.

## one durable host-global demand path

all producers on one host must call one boundary:

```ts
requestMaintenance({
  reason,
  scopes,
  sourceHints,
  priority,
  notBefore,
});
```

under a short demand lock, this boundary:

- increments a monotonic host-local generation;
- merges scopes as a set;
- keeps the earliest eligible time;
- keeps the highest requested priority;
- deduplicates bounded source hints;
- records hint overflow as a root-discovery requirement;
- atomically persists `demand/current.json`;
- ensures the supervisor wake file exists.

extensions stop detaching maintainer processes. tier continuation records demand rather than spawning. launchd and systemd invoke one dispatcher entrypoint for both wake and periodic ticks.

the dispatcher snapshots generation `g`. it may mark demand satisfied through `g` only when:

- no eligible local workflow remains for the requested scopes;
- no bounded slice stopped with continuation;
- the current demand generation is still `g`.

if another producer advances the generation, wake remains set. a crash also leaves wake set. this supplies process-global coalescing on one host without treating the wake file as workflow state.

host-local demand is intentionally not synchronized across machines. cross-host coordination has one narrower boundary: fetch and compare-and-swap `origin/main`. sharing workflow queues through Syncthing would create distributed lease and clock semantics without improving canonical correctness.

### backpressure and fairness

- integrity, checkout verification, and incomplete accepted-merge recovery are selected first.
- other lanes use round-robin selection with age promotion.
- a repeatedly failing workflow cannot run again before `nextAttemptAt`.
- one source, workspace, or workflow kind cannot consume an entire slice while another eligible lane waits.
- repeated equivalent demand is coalesced by scope and source identity.
- no integrity demand is dropped; bounded hint overflow becomes root discovery.
- proposal generation pauses only when its finite, measurement-selected backlog cap is reached; maintenance and canonical retrieval continue.
- reaching a work, byte, cpu, memory, hint, or lock boundary persists continuation and exits successfully as incomplete work rather than overrunning the host.
- qmd publication is demanded only by a changed verified canonical head or explicit repair.
- Git fetch may be periodic or merge-triggered; remote outage schedules retry rather than blocking a worker.
- a non-fast-forward push returns the merge workflow to rebase, not to generic failure.
- blocked changed-target proposals do not monopolize merge retries.

### resource limits

these limits matter because the maintainer processes large files and may run beside interactive agent work. they prevent one maintenance pass from consuming unbounded memory, disk, processor time, or queue space. most exact numbers are internal tuning knobs, not product decisions.

one model invocation per host is **DECIDED**. it applies across reflection, critic, corpus-doctor, and tier model steps sharing that host’s workflow store. model work may overlap across hosts because it creates isolated proposals; canonical merges remain globally serialized.

| plain-language limit | why it exists | what the user would notice | architecture decision |
|---|---|---|---|
| model jobs running at once | model calls can be expensive and competing calls make host load and cost harder to understand | additional proposals wait rather than running together | **decided policy:** one active model invocation per host |
| elapsed time for one work turn | a dispatcher must yield instead of occupying the host indefinitely | very large maintenance work finishes over several resumable turns | **safety boundary:** every turn is finite; exact value comes from shadow and natural-corpus timing |
| processor work for one turn | elapsed time alone misses a short but processor-heavy pass | less sustained fan, heat, or interactive slowdown; work may resume later | **safety boundary:** processor use is finite; exact value is measured tuning |
| source data read in one turn | one large source or append must not monopolize the dispatcher | large updates may take several turns while ordinary work stays responsive | **safety boundary:** reads are streamed and finite per turn; exact value is measured tuning |
| source data held in memory | malformed or unusually large input must not create an unbounded memory spike | an oversized individual record is quarantined with a clear error instead of exhausting memory | **hard safety boundary:** buffering is finite and no whole source is retained in memory; exact cap comes from the largest valid fixtures and natural corpus plus headroom |
| ordinary maintenance jobs running at once | more workers may improve freshness but can increase filesystem and processor contention | updates may complete faster or slower depending on host load | **implementation tuning:** measure contention and queue age; correctness does not depend on the chosen count |
| qmd and Git jobs running at once | concurrent writers to the same index or checkout would conflict | publication may queue briefly rather than race | **correctness boundary:** one writer per mutable target; concurrency between independent targets is measured tuning |
| changed-path hints remembered for one wake | a trigger storm must not create an unlimited list in memory or on disk | after a very large burst, discovery performs a paged root scan instead of remembering every path | **hard safety boundary:** hints are finite and overflow becomes one durable `root-scan-needed` demand; exact count is measured tuning |
| unreviewed proposal backlog | proposal generation must not grow storage without limit | new proposal generation pauses while review, maintenance, and retrieval continue | **safety boundary:** backlog is finite; exact cap follows observed proposal and review flow |
| time holding the canonical checkout lock | other canonical publication must not wait behind model, network, qmd, or other long work | canonical freshness may queue briefly, but the usable checkout is not held hostage by external work | **correctness boundary:** external work never holds this lock and every lock body has a finite deadline; target and alert values come from materialization measurements |
| unchanged-source reads and writes | idle maintenance should not repeatedly process the corpus | no-change wakes remain quiet and cheap | **required invariant:** zero source-content bytes read and zero source, projection, or checkpoint-job writes |

shadow runs record elapsed time, processor time, bytes read, peak buffered data, queue age, hint bursts, lock duration, external-process contention, and continuation count without treating initial tuning values as promises. natural-corpus runs then choose versioned defaults that cover ordinary valid work with headroom while still yielding before one lane monopolizes the host.

before calibration, no limit may be disabled or represented as unbounded. inputs are streamed, mutable targets have serialized writers, work may stop after every complete record, hints collapse to paged discovery on overflow, and an individual record that exceeds the finite bootstrap buffer is quarantined. bootstrap caps come from valid fixtures and the observed corpus; they are replaced by measured defaults before cutover.

changing a tuning value does not require user approval or an architecture revision as long as these safety and correctness behaviors remain intact. a product decision is needed only if a future latency, freshness, or cost promise requires an explicit user-visible objective.

### leases and suspension

- claiming uses a short workflow-store lock and writes a lease token plus expiry.
- deterministic work may renew only at explicit continuation checkpoints.
- model, Git, qmd, and other external-process waiting has no checkout lock and no blocked dispatcher.
- expired leases are reconciled from durable state.
- retries have an explicit `nextAttemptAt`; the dispatcher does not sleep until that time.
- each waiting or retrying state owns its expiry and expiry consequence.
- a workflow lease grants no cross-host canonical authority; only a successful remote fast-forward does.

## model execution and branch preparation outside the checkout lock

reflection, critic, corpus-doctor, and tier model steps follow the same sequence:

1. **prepare:** under a short local workflow lock, capture the workflow revision, last verified remote head, catalog digest, relevant source revisions, prompt digest, model configuration, and immutable input artifact.
2. **persist:** transition to `waiting/model-output` with an invocation id, timeout, expiry, and opaque continuation.
3. **invoke:** release all workflow and checkout locks, claim the host’s single model-invocation slot, run the audited model process, and persist output or a typed failure.
4. **resume:** transition the workflow to ready when output exists.
5. **validate:** parse and bind output to its prepared input and invocation id.
6. **propose:** persist the model result as an immutable proposal; do not edit canonical memory.
7. **admit:** evaluate provenance, epistemic integrity, safety, expiry, structure, and convergence against the exact proposal digest.
8. **prepare branch:** construct the transaction and candidate tree in host-local Git state while the usable checkout remains unchanged.
9. **merge:** invoke the canonical merge reconciler, which fetches, rebases by exact path preconditions, creates a commit on the fetched head, and performs a fast-forward compare-and-swap push.
10. **materialize:** after remote acceptance, update and verify the local checkout, catalog, and qmd-source under a short local lock.
11. **stale basis:** retain stale output and proposal evidence under the host-local evidence policy, then return `basis-changed`; never silently rewrite the proposal against changed target content.

the model invocation itself may be at-least-once if the provider offers no idempotency contract. before retrying an expired invocation, the reconciler inspects the audited session and expected output artifact by invocation id.

the accepted retry policy is one active invocation per host, a 120-second per-call timeout, and at most three attempts with delayed jittered backoff near 1, 5, and 30 minutes. honor a valid provider `retry-after`. retry rate limits, transient unavailability, interrupted audited sessions without recovered output, and timeouts. do not retry schema-invalid output, safety rejection, stale basis, unsupported configuration, or a closed canonical-admission decision without a new basis or explicit remediation.

## observability and health

### context-rich operation events

follow [`CONTEXT-RICH EVENTS`](https://github.com/bdsqqq/igorbedesqui.com/blob/main/packages/pattern-language/context-rich-events.md): emit one accumulated terminal event for each significant reconciliation, model invocation, merge attempt, checkout publication, or recovery operation. do not scatter lifecycle facts across unrelated log lines.

each event contains bounded fields sufficient to understand the operation independently:

```text
schema version
service, environment, host id, and operation
operation, workflow, proposal, admission, mutation, transaction, and invocation ids
workflow kind, step, record revision, attempt, and trigger reasons
source and target memory ids when applicable
prior state and next state
prepared base, fetched remote head, candidate commit, accepted remote head, and local checkout head
proposal, basis, policy, catalog, source, and artifact digests
admission outcome and bounded reason codes
lease owner, token fingerprint, and timing
finite work limits allowed and consumed
bytes statted, read, parsed, and written
files opened, created, reused, and replaced
model, qmd, Git fetch, Git push, and checkout timing
merge outcome: prepared, waiting, rebased, conflicted, accepted, already-applied, or failed
workflow outcome: succeeded, suspended, retried, blocked, failed, cancelled, or expired
typed failure code and safe retained reason
next eligible time, lifecycle expiry, and host-local retention class
```

raw prompts, model bodies, memory bodies, stack dumps, tokens, and unbounded lists remain redacted artifact references rather than event dimensions. identifiers may be high-cardinality where they enable precise querying; duplicate fields and unbounded dimensions are rejected because Axiom cost scales with event size and dimensionality.

### Axiom transport

retain the existing local jsonl drain and durable pending markers under `~/.local/state/pi/logs` as a bounded telemetry transport, not as workflow history. add a dedicated OpenTelemetry `filelog/pi-wide-events` receiver on Darwin and Linux that:

- includes `~/.local/state/pi/logs/*.jsonl`;
- excludes the `pending/` marker directory;
- parses each line as json rather than forwarding an opaque body;
- uses collector `file_storage` checkpoints;
- starts at end on first installation to avoid an accidental historical flood;
- adds host and environment resource attributes;
- routes through the existing Axiom logs exporter and collector-owned token;
- preserves pi’s redaction and bounded-event rules;
- retries transport independently from pi-memory workflows;
- removes acknowledged rotations before unacknowledged rotations;
- enforces a measured hard local byte cap so a prolonged collector outage cannot fill the host disk;
- never evicts active pending-operation markers through telemetry rotation;
- records an explicit telemetry-gap counter and degraded health state if the hard cap requires dropping unacknowledged events.

pi-memory does not receive an Axiom token and does not synchronously call Axiom. local event persistence succeeds or fails independently of domain transitions. collector or Axiom outage cannot reopen, retry, authorize, or roll back a memory workflow.

an end-to-end canary must emit a known operation id, flush the local drain, wait for collector ingestion, and query Axiom for that exact id. local-file presence alone does not prove transport.

### retention classes and default selection

retention follows authority rather than one global duration:

- accepted Git commits, every historical canonical memory version, commit-encoded history-verification receipts, accepted admission summaries, and canonical-evidence capsules never expire;
- canonical-evidence capsule paths are append-only and excluded from qmd, retrieval, prompt construction, and telemetry;
- nonterminal workflows, pending or blocked proposals, unmerged candidate refs, and every referenced artifact remain until the work reaches a safe terminal state or its lifecycle policy resolves it;
- configured source files remain under producer retention and are never deleted by the maintainer;
- copied source snapshots, prompts, complete model or tool outputs, terminal workflows, expired-proposal summaries, replay evidence, and other maintainer-owned host-local artifacts may be cleaned only after active-reference tracing and verification that every accepted dependent claim has a reachable valid capsule;
- the full accepted proposal and host-local admission record may expire after the accepted commit preserves the exact mutation, proposal digest, accepted admission summary, and capsule binding;
- local canonical and qmd projections, indexes, and receipt caches are rebuildable and may be replaced or removed after their accepted basis verifies;
- local jsonl and pi’s Axiom wide-event stream contain bounded runtime telemetry only and may expire without changing memory, evidence, admission, or workflow state.

host-local cleanup first runs in report-only mode against the natural corpus. defaults are selected from observed retry, review, recovery, and artifact-reference lifetimes, available disk policy, and cleanup volume. no cleanup class is enabled until active-reference protection, capsule reachability, capsule safety validation, and rebuild checks pass.

Axiom duration is owned by cost and privacy, not correctness. before pi wide-event export is enabled, deployment must name the target dataset and either set an explicit retention policy or record the documented inherited account policy. that duration is surfaced in health and may change without a memory migration. pi’s Axiom stream never stores canonical evidence and cannot compensate for a missing capsule. no additional user architecture decision is required.

### truthful health summary

`pi-memory status` must print or return the complete summary before paths to raw evidence:

1. **overall:** `healthy`, `degraded`, `blocked`, or `unknown`;
2. **authority and convergence:** last verified remote head, local checkout head, remote age, pending merges, non-fast-forward retries, blocked changed-target proposals, and any observed Syncthing canonical conflict;
3. **completeness:** registry coverage, discovery cursor age, uninspected roots, and invalid records;
4. **integrity:** quarantined sources, conflicting ids, duplicate workflow revisions, invalid receipts, missing or invalid evidence capsules, dead claim mappings, unverified commits, unsafe proposals, and admission failures;
5. **activity:** demand generations, claims, completions, retries, proposals, reviews, admissions, merges, and expiries;
6. **operational health:** queue age by lane, lease expiry, failure codes, bytes processed, writes avoided, lock duration, cpu, wall time, model calls, and external calls;
7. **retrieval diagnostics:** paired cases, grade coverage, retrieval labels, useful/harmful outcomes, task delta, retrieval delta, and prompt-budget effects;
8. **telemetry:** local transport bytes and oldest event age, pending-marker count, dropped-event count, collector checkpoint age, configured Axiom dataset policy, last successful Axiom canary, and transport failures;
9. **local cleanup:** active references, capsule-reachability blockers, terminal records and bytes eligible for cleanup, unreferenced artifacts, current class policies, report-only status, and failed cleanup;
10. **evidence:** paths, commit ids, and digests for detailed records and events.

missing or stale authority, integrity, or operational evidence produces `unknown`, not green. retrieval diagnostic evidence may remain empty without closing canonical admission. Axiom ingestion may be degraded and local telemetry may be dropped while workflow recovery remains healthy because neither transport is workflow authority. canonical-history retention is reported as an invariant, not as cleanup eligibility.

### diagnosable retries

a retry must retain:

- the exact typed error and bounded evidence references;
- attempt number and prior attempt timestamps;
- whether provider or remote guidance supplied `retry-after`;
- next eligible time;
- model, prompt, prepared-input, source, catalog, proposal, and Git-head basis;
- final reason when policy exhausts retries.

terminal `failed` records preserve the final reason through their configured host-local evidence window. aggregate health may retain bounded failure counts after raw local records are removed. neither cleanup changes accepted Git history nor removes a receipt needed to verify it.

## canonical admission and diagnostic evaluation

memory is durable, evolving knowledge of what happened across agents. admission therefore asks whether a proposed memory is safely and honestly represented, not whether a benchmark proves it will improve a future task.

### canonical admission gate

automatic and manual acceptance produce a durable decision bound to the exact proposal:

```ts
const AdmissionDecisionSchema = schema.object({
  schemaVersion: schema.literal(1),
  policyVersion: schema.safeInteger({ min: 1 }),
  decisionId: AdmissionDecisionIdSchema,
  proposalId: ProposalIdSchema,
  proposalSha256: Sha256Schema,
  evaluatedAt: TimestampSchema,
  expiresAt: TimestampSchema,
  basis: schema.object({
    hostLocalSourceEvidence: schema.array(ArtifactRefSchema),
    catalogSha256: Sha256Schema,
    targetHead: GitCommitSchema,
    promptPolicyVersion: schema.safeInteger({ min: 1 }),
    modelPolicyVersion: schema.safeInteger({ min: 1 }),
  }),
  checks: schema.object({
    provenance: AdmissionCheckSchema,
    epistemicIntegrity: AdmissionCheckSchema,
    safety: AdmissionCheckSchema,
    structure: AdmissionCheckSchema,
    convergence: AdmissionCheckSchema,
  }),
  result: schema.discriminatedUnion("type", [
    schema.object({
      type: schema.literal("merge-ready"),
      evidenceCapsule: schema.object({
        relativePath: CanonicalEvidencePathSchema,
        sha256: Sha256Schema,
      }),
    }),
    schema.object({
      type: schema.literal("closed"),
      reasons: schema.array(AdmissionReasonSchema),
    }),
  ]),
});

type AdmissionDecision = Infer<typeof AdmissionDecisionSchema>;
```

the gate passes only when all of these hold:

#### provenance

- the memory identifies the agent/session, time, normalized workspace or scope, and retained canonical-evidence entries needed to support it;
- user statements, tool observations, external-source claims, and model inferences remain distinguishable;
- every quoted, specific factual, preference, or instruction claim maps by claim digest to retained claim-bearing bytes in the canonical-evidence capsule;
- a host-local artifact digest or admission attestation without retained safe supporting bytes is lineage metadata only and cannot satisfy provenance;
- missing provenance is represented as unknown and blocks merge.

#### factual and epistemic integrity

- the proposal does not promote an inference, guess, or stale statement into an observed fact;
- uncertainty and disagreement remain explicit;
- a newer claim that contradicts canonical knowledge links to or supersedes the older claim rather than silently erasing history;
- summaries preserve material qualifiers, chronology, and actor;
- unverifiable interpretation may be retained only when labeled as interpretation with its provenance.

#### safety

- secret and credential scans pass over canonical markdown, receipt fields, the accepted admission summary, and capsule bytes;
- unsafe paths, symlinks, oversized content, prompt-injection artifacts, and forbidden content are rejected or quarantined;
- raw sensitive evidence remains host-local and may be represented canonically only by a bounded safe redaction that still supports the claim;
- secret values, reversible encrypted copies, and unsafe secret-derived fingerprints are never committed as evidence;
- if no safe sufficient representation exists, the memory does not merge. manual review may narrow or remove the unsupported claim but may not bypass the hard safety policy.

#### structure

- memory schema, ids, references, graph constraints, archive status, and size bounds validate;
- the operation’s before and after digests match its rendered content;
- proposal and mutation ids are collision-free and idempotent.

#### convergence

- the proposal is unexpired and bound to compatible source, target, catalog, prompt, model, and admission policy versions;
- target path preconditions support deterministic application to the latest fetched head;
- desired content already present is success;
- changed target content blocks instead of being resolved through last-write-wins or generic merge;
- every accepted result produces one reconstructible receipt and one linear remote commit.

missing, malformed, expired, incompatible, unsafe, digest-only, or insufficient retained evidence closes merge readiness but does not stop maintenance or delete the proposal. deterministic maintenance and every automatic path use this same gate. once the accepted commit is verified, host-local source artifacts may expire without breaking auditability because the receipt, accepted admission summary, claim map, and supporting capsule bytes remain reachable from `origin/main`.

### proposal expiry

a pending proposal expires after 30 days or immediately when its source evidence, target artifact, catalog basis, prompt-policy version, model-policy version, or admission-policy version becomes incompatible. retain a host-local expired summary under the local evidence policy and require a newly bound proposal rather than silently refreshing the old record. proposal expiry never removes accepted canonical history.

### paired replay

each representative case freezes:

- session evidence and task boundary;
- model and reasoning configuration;
- prompt and tool policy;
- catalog and memory artifact digests;
- expected grading rubric.

run at least:

- `memory-on`: the candidate memory state;
- `memory-off`: the same frozen case without memory injection.

grading should be blinded to arm identity where feasible. unpaired outputs do not contribute to paired comparisons.

### retrieval labels

labels bind:

- query digest;
- workspace and task context;
- candidate-set digest;
- ordered memory ids and artifact digests;
- which results were exposed or opened;
- outcome: useful, harmful, irrelevant, or unknown;
- optional correction or citation evidence;
- label source and timestamp.

labels attach to immutable memory artifact digests so later edits do not rewrite prior evidence.

paired replay, retrieval labels, task delta, recall, and ranking metrics may tune retrieval, compaction, prompt budgets, or presentation. they must not veto admission of a safely represented event solely because future usefulness is unknown, and their absence must not pause canonical merges.

## phased migration

this is not one rewrite. each phase has one authority, explicit compatibility, a narrow proof, and a rollback boundary. maintenance, retrieval, and proposal generation continue throughout. when a phase cannot safely merge, work remains isolated and durable rather than mutating canonical state.

effort labels are relative: `s` is one small slice, `m` is several cohesive slices, and `l` is a multi-module phase.

### phase 0 — establish fixtures, policy, and rollout inventory

**effort:** m

**scope**

- capture representative append, branch, truncation, replacement, conflict, malformed, transaction, proposal, merge-race, remote-outage, and crash fixtures;
- record current projection, recovery, consolidation, lock, cpu, byte, write, and cross-host conflict behavior;
- inventory every host and process capable of calling the current mutation path;
- define the canonical admission policy and fixtures without requiring task-uplift evidence;
- add unconditional `.stversions` and `*.sync-conflict-*` rejection to source and qmd publication fixtures;
- record the current remote head and verify its semantic history;
- classify every resource control as a correctness or safety boundary versus a measured tuning value;
- instrument shadow measurements for elapsed time, processor use, bytes, buffers, queue age, hint bursts, lock duration, backlog, and contention;
- inventory canonical, active local, terminal local, derived, local-telemetry, and Axiom retention classes, including every reference that blocks local cleanup;
- record the configured Axiom dataset and its explicit or inherited cost/privacy retention policy;
- inventory current canonical memories whose supporting source bytes are already unavailable; do not infer evidence from receipts or digests alone;
- add capsule fixtures covering exact excerpts, safe redaction, material-context overflow, secret-only evidence, dead host-local references, and rebuild from a fresh clone.

**checks**

- fixture digests and expected current projections are reproducible;
- current automatic application is demonstrated through the traced `applyMemoryProposal` path;
- every active canonical writer and Syncthing peer is accounted for;
- no empty evaluation store is interpreted as an admission failure.

**exit criteria**

- later phases have a reproducible baseline and rollback signal;
- the selected remote baseline and all active writer hosts are known;
- architecture safety boundaries are fixed, measurement fields are defined, and no numeric implementation-tuning value remains a user approval gate;
- indefinite retention for canonical knowledge and audit evidence, plus noncanonical cleanup classes, is explicit; local cleanup remains report-only until measured defaults and reference protection pass.

**rollback**

- no storage authority changes occur.

### phase 1 — branch preparation and single canonical authority

**effort:** l

**scope**

- separate proposal preparation from canonical checkout mutation;
- prepare candidate trees and commits in host-local Git state;
- implement fetched-head validation, exact-path rebase, immutable receipt lookup, and fast-forward-only remote CAS;
- materialize the local checkout only after remote acceptance;
- deploy the canonical-memory Syncthing exclusion to every peer;
- point qmd at the verified local qmd-source projection;
- preserve one explicit compatibility writer during rollout only if hosts cannot switch atomically; all other hosts remain branch-only;
- retire compatibility-writer mode immediately after every active host recognizes the new protocol.

**compatibility**

- existing proposal, review, transaction, markdown, and encoded history-receipt formats remain readable;
- current local base-content validation is reused inside branch preparation;
- the canonical root path remains unchanged for extensions and grep;
- maintenance and proposal generation remain active.

**checks**

- two hosts preparing from the same head never both publish different successors;
- disjoint touched paths rebase and merge in a linear order;
- a changed target path becomes `blocked` with retained evidence;
- an already accepted mutation is detected after a lost push response;
- remote outage leaves canonical retrieval and proposal preparation usable;
- local files do not change before remote acceptance;
- every Syncthing peer ignores the complete canonical subtree;
- `.stversions` and `*.sync-conflict-*` produce zero qmd entries;
- `.pi-memory/**` evidence files produce zero catalog, qmd, retrieval, and prompt entries;
- rollback creates a compensating commit rather than rewriting history.

**exit criteria**

- `origin/main` is the only canonical cross-host mutation authority;
- all active hosts materialize the same verified remote head;
- no active path directly applies a proposal to canonical memory before remote CAS;
- Syncthing no longer advertises or receives canonical memory files.

**rollback**

- before authority cutover, retain the prior writer path;
- after cutover, disable new merges while preserving branches and use a reviewed compensating commit for canonical correction; do not re-enable dual Git/Syncthing authority.

### phase 2 — durable demand and workflow shell

**effort:** m

**scope**

- add v3 host-local demand records, generation, short demand lock, and wake ownership;
- route extension, supervisor tick, tier continuation, remote retry, and checkout publication through `requestMaintenance`;
- introduce schema-derived workflow records, finite bootstrap safeguards, durable continuation at work boundaries, and measurements used to select later defaults;
- initially represent remaining monolithic work as compatibility workflows;
- enforce one model invocation per host.

**checks**

- a trigger storm produces one merged host demand sequence with no lost scope;
- crash points leave wake truthful;
- duplicate dispatchers result in one valid local claim;
- merge waiting consumes no worker;
- two local model workflows never invoke concurrently.

**exit criteria**

- triggers are host-globally coalesced and diagnosable;
- no extension directly detaches `maintain`;
- remote serialization remains independent of local dispatcher duplication.

**rollback**

- switch the supervisor entrypoint back while retaining additive workflow records; canonical Git authority remains unchanged.

### phase 3 — shadow incremental source registry and projection

**effort:** l

**scope**

- add source policies, registry records, bounded discovery cursors, entry/checkpoint indexes, and projection manifests;
- run v3 source reconciliation in shadow mode;
- compare v3 projection and checkpoint outputs against v2;
- publish a shadow qmd-source containing only catalog-verified accepted memory;
- exercise the configured trusted-producer append path and complete streaming fallback path.

**checks**

- unchanged source: zero source-content bytes and zero projection/job writes;
- trusted append: only the saved boundary proof and appended bytes are read, and every new entry is validated against the accepted index;
- truncation, replacement, same-size mutation, failed boundary proof, untrusted producer, and policy change select complete streaming fallback;
- a trusted append fixture explicitly demonstrates that the fast path does not claim whole-prefix revalidation;
- graph, receipt, checkpoint, branch, summary, projection-size, and quarantine behavior matches fixtures;
- conflict/version paths are rejected before registration and qmd publication;
- kill-point tests cover every crash-ordering step.

**exit criteria**

- every configured trusted append producer and every untrusted or non-append source policy has shadow coverage;
- source records and qmd-source can be rebuilt from canonical inputs;
- no-change and append complexity invariants hold;
- natural-corpus measurements have selected versioned defaults for slices, reads, buffers, workers, hints, backlog, and lock targets without weakening finite-boundary behavior.

**rollback**

- disable shadow dispatch and delete only derived v3 artifacts after inspection.

### phase 4 — bounded recovery, direct indexes, and split external work

**effort:** l

**scope**

- add direct proposal-id indexes;
- partition transactions into nonterminal and terminal paths;
- convert checkpoint jobs, proposal checks, transactions, merge attempts, and checkout publication to durable workflows;
- carry immutable catalog, source, proposal, and Git-head references;
- separate model prepare, invoke, validate, proposal persistence, admission, branch preparation, merge, and materialization;
- move model, qmd, and Git processes outside the checkout lock;
- add delayed retry and typed terminal failure.

**checks**

- terminal transactions cause zero proposal parses during normal recovery;
- one proposal resolves through one indexed record;
- selecting one window does not parse unrelated proposals or source snapshots;
- no model or external process runs inside the checkout lock;
- persisted model output is recovered without reinvocation;
- non-fast-forward races rebase or block according to touched-path preconditions;
- fault injection after every durable step converges without duplicate remote mutation.

**exit criteria**

- recovery cost is proportional to nonterminal records;
- proposal lookup is direct;
- every model and merge failure retains its reason and basis;
- process termination during inference or push is recoverable.

**rollback**

- stop creating new split workflows and let existing records finish or cancel; accepted Git history remains compatible.

### phase 5 — canonical admission, Axiom transport, and health

**effort:** l

**scope**

- enforce provenance, epistemic, safety, structure, expiry, and convergence admission for every merge path;
- preserve paired replay and retrieval labels as diagnostics;
- publish authority/convergence, integrity, activity, operational, retrieval, telemetry, and local-cleanup health;
- add the dedicated JSON OpenTelemetry receiver for pi wide events;
- route it through the existing Axiom exporter;
- add an end-to-end Axiom operation-id canary;
- configure or document the inherited Axiom dataset retention policy and expose it in health;
- enforce bounded local jsonl rotation, acknowledged-first cleanup, hard-cap behavior, and telemetry-gap reporting;
- commit an accepted admission summary and canonical-evidence capsule with every newly accepted mutation;
- reaffirm legacy current memories with new evidence-bearing commits where safe source evidence remains; otherwise preserve them with an explicit `legacy-unverified` provenance state rather than presenting dead digests as verified evidence.

**checks**

- missing, stale, malformed, or mismatched admission evidence closes merge readiness;
- no reflection, corpus-maintenance, tiering, migration, or skill path bypasses admission;
- an empty evaluation store does not close a provenance-valid admission;
- unsafe or epistemically promoted claims remain blocked;
- Axiom contains the complete parsed event for a canary operation id;
- collector outage leaves local workflow recovery and canonical decisions unchanged;
- high-cardinality payloads remain artifact references;
- the pi Axiom stream contains only bounded runtime telemetry, not canonical memory or workflow recovery artifacts;
- a full local transport buffer degrades telemetry health without blocking or changing domain work;
- the configured or inherited Axiom retention policy is visible and changing it does not alter workflow or canonical state;
- a fresh clone resolves every newly accepted claim to capsule bytes and never resolves `.pi-memory/**` as a qmd or retrieval document;
- secret-only or materially truncated evidence closes merge readiness.

**exit criteria**

- every v3 canonical commit has a valid mutation receipt, accepted admission summary, and bound evidence capsule;
- retrieval diagnostics are visibly separate from admission;
- Axiom transport is verified on each supported platform;
- health reports remote lag and local checkout basis truthfully;
- Axiom cost/privacy retention ownership is documented separately from canonical memory retention;
- a fresh host with only a full verified `origin/main` clone can resolve every current provenance-verified claim to retained capsule bytes;
- no legacy commit without a capsule is reported as provenance-verified, and unsupported legacy claims remain explicitly qualified rather than silently asserted as verified.

**rollback**

- stop automatic admission while preserving proposal generation and manual remediation;
- disable the collector receiver without changing workflow state or accepted history.

### phase 6 — cutover, local cleanup, and monolith retirement

**effort:** m

**scope**

- make independently invocable reconcilers authoritative;
- remove the monolithic compatibility workflow and temporary compatibility writer;
- enable measured cleanup for unreferenced terminal workflow, proposal, model, replay, projection, index, cache, and local telemetry classes;
- keep accepted commits, every historical canonical memory version, commit-encoded history-verification receipts, accepted admission summaries, and canonical-evidence capsules indefinitely;
- rebuild local receipt caches, catalogs, qmd-source, and indexes from accepted Git history;
- investigate logger-marker lifetime separately if it remains measurable.

**checks**

- natural no-op, trusted append, full fallback, backlog, crash, trigger-storm, retry, model, merge-race, remote-outage, local-telemetry-cap, and Axiom probes satisfy the architecture invariants and measurement-selected defaults;
- a full local rebuild from accepted Git history and source inputs reproduces derived state;
- cleanup never deletes accepted commits, historical canonical memory versions, commit-encoded receipts, accepted admission summaries, canonical-evidence capsules, nonterminal work, blocked work awaiting action, or artifacts referenced by retained local records;
- final architecture contains no second scheduler, second canonical authority, direct canonical apply path, or fallback full-maintain call.

**exit criteria**

- v3 is the sole maintenance authority;
- `origin/main` is the sole canonical authority;
- compatibility import reports no unresolved records;
- rollback artifacts are unreferenced and have passed their measured host-local evidence policy;
- authority, integrity, operational health, retrieval diagnostics, local cleanup, and telemetry transport are independently visible.

**rollback**

- deploy the prior compatible code only if it preserves Git-first serialization. unfinished v3 work may be exported to legacy proposal shape, but canonical history must not return to Syncthing or local-before-remote mutation.

## acceptance benchmarks

the redesign should be rejected or revised if it cannot prove all of the following:

### cross-host authority

- two hosts racing from one remote head produce one accepted successor and one deterministic retry;
- disjoint-path work rebases onto the winning head;
- changed-target work blocks without generic merge or last-write-wins;
- canonical files remain unchanged until the remote accepts the commit;
- a lost push response is recovered by mutation-receipt lookup without duplicate commit;
- every host materializing the same remote head produces the same canonical tree;
- offline hosts can retrieve and prepare work but never report local-only work as merged;
- no canonical memory path is exchanged through Syncthing after cutover;
- no active code path force-pushes or rewrites accepted history.

### workflow and projection

- a no-change run reads zero session-content bytes and rewrites zero projections;
- a trusted single append reads only its bounded continuity proof and appended bytes, and does not inspect unrelated source content;
- the trusted append path makes no claim that every earlier accepted byte was revalidated;
- non-append evidence, an untrusted producer, or a failed continuity proof performs complete streaming validation and quarantines invalid or unstable input;
- terminal transaction count does not affect normal recovery time;
- total proposal count does not affect direct proposal lookup;
- pending proposal count does not affect selection of one unrelated window;
- repeated triggers during one active slice produce a later host demand generation, not parallel maintenance;
- every finite work boundary produces a resumable workflow record;
- source buffers, continuations, hint sets, queues, proposal backlog, and local telemetry remain finite under oversized inputs, trigger storms, and collector outages;
- mutable qmd, checkout, and index targets never have competing writers;
- killing the process at each transition point converges without lost work or duplicate canonical mutation;
- one host never runs more than one model invocation concurrently;
- while a retry or blocked workflow remains active, its typed reason, basis, and referenced evidence remain recoverable;

### admission and retrieval

- every accepted mutation has provenance, epistemic, safety, structure, expiry, and convergence evidence bound to its proposal digest;
- deleting every eligible maintainer-owned terminal, source-snapshot, model, replay, proposal, and admission artifact leaves every provenance-verified current claim auditable from a fresh full clone of `origin/main`;
- a claim supported only by a dead digest or an unsafe-to-retain source cannot merge;
- material evidence is never silently truncated to satisfy capsule limits;
- unsupported inference is not stored as observed fact;
- conflict and supersession remain explicit;
- automatic paths cannot bypass admission;
- absent paired replay or retrieval labels do not block a provenance-valid memory;
- health does not equate accepted proposals, completed events, or retrieval exposure with usefulness.

### qmd, observability, and retention

- `.stversions`, every descendant of `.stversions`, and `*.sync-conflict-*` yield zero qmd documents;
- the reserved `.pi-memory/**` canonical audit subtree yields zero catalog, qmd, retrieval, and prompt documents;
- qmd indexes only the verified qmd-source manifest for the current accepted head;
- one significant operation produces one bounded context-rich event rather than scattered lifecycle logs;
- a canary operation id is queryable in Axiom with host, workflow, business state, timing, and outcome;
- Axiom or collector outage does not alter workflow recovery, admission, or merge behavior;
- accepted Git commits, every historical canonical memory version, their commit-encoded verification receipts, accepted admission summaries, and canonical-evidence capsules remain reachable after local cleanup;
- terminal local evidence is removed only after reference tracing proves no nonterminal or blocked work depends on it;
- local jsonl remains within its hard byte cap and reports any telemetry gap caused by eviction;
- the configured or inherited Axiom dataset retention policy is visible and has no effect on workflow recovery or canonical history.

new TypeScript behavior follows [`modules/pi/AGENTS.md`](modules/pi/AGENTS.md): tests live inline with their source behavior, mock only filesystem, model, process, clock, network, or other true boundaries, and verify outcomes. each TypeScript slice runs the narrowest targeted vitest plus:

```bash
pnpm exec tsc -p tsconfig.build.json --noEmit
```

changes to qmd configuration, Syncthing exclusions, `modules/pi-memory/default.nix`, or `modules/o11y/default.nix` alter Nix-produced configuration and require, on Darwin:

```bash
nix build .#darwinConfigurations.mbp-m2.system --dry-run
nix build .#darwinConfigurations.mbp-m2.system
```

## what not to build

- **no microservices:** all units remain local functions and cli entrypoints in the existing package.
- **no generic workflow engine:** implement only the states, transitions, leases, and indexes required by agent-memory maintenance.
- **no peer-to-peer consensus or CRDT by default:** offline proposal work is required; offline completion of concurrent canonical merges is not.
- **no universal event sourcing:** canonical markdown and accepted Git commits are authority. workflow records are current durable state, and context-rich events are diagnostic evidence.
- **no Syncthing canonical transport:** the memory subtree is ignored on every peer; generic conflict automerge must never arbitrate memory.
- **no designated steady-state writer:** every compatible host may attempt a remote CAS merge. a temporary migration writer is not a permanent architecture.
- **no local commit treated as merged:** only a commit accepted onto `origin/main` belongs to the shared pool.
- **no generic changed-target merge:** exact path preconditions either rebase cleanly, observe the desired result, or block.
- **no force push or history rewrite:** rollback is a compensating proposal and commit.
- **no database:** storage remains file-backed unless a future explicit decision changes it.
- **no daemon as authority:** launchd or systemd may start dispatchers, but durable records and remote Git history own truth.
- **no watcher-only correctness:** watch events accelerate discovery; registry reconciliation establishes state.
- **no global cache hidden in process memory:** reusable state is explicit, bounded, schema-validated, and recoverable.
- **no shared workflow leases through Syncthing:** workflow coordination is host-local; only canonical merge is cross-host serialized.
- **no qmd indexing of raw filesystem accidents or audit internals:** qmd consumes the verified projection, never `.stversions`, conflicts, branches, untracked files, or `.pi-memory/**` canonical evidence.
- **no Axiom as workflow state:** telemetry transport cannot authorize, retry, recover, or roll back domain work.
- **no usefulness gate for memory admission:** task uplift and retrieval labels diagnose retrieval behavior; provenance, epistemic integrity, safety, and convergence govern canonical inclusion.

## user decisions

<a id="decision-pause-autonomy"></a>

### maintenance during migration

> [!DECISION]
> do not pause maintenance. canonical retrieval, source processing, proposal generation, review, and branch preparation continue throughout migration.
>
> maintenance behaves like branch work: the last accepted canonical checkout remains usable while work is isolated. a proposal changes the shared pool only after admission and successful remote compare-and-swap.
>
> the model already emits proposals, but current maintenance subsequently auto-accepts some proposals through `applyMemoryProposal`. the redesign preserves proposal generation while removing direct canonical application from that path.

<a id="decision-canonical-authority"></a>

### canonical cross-host authority

> [!DECISION]
> use the existing Git remote’s `origin/main` as the sole serialization authority for the one logical memory pool.
>
> each accepted commit is an immutable shared knowledge and audit record containing canonical memory, its receipt, accepted admission summary, and bounded claim-bearing evidence capsule. hosts may prepare while offline, but a merge completes only when a normal fast-forward-only push succeeds against the fetched head.
>
> exclude the complete canonical memory subtree from Syncthing on every peer. Syncthing and Git must not both replicate mutable canonical files.
>
> reverse this only if canonical merges must complete while no remote is available. that stronger requirement warrants immutable peer mutation records and deterministic local materialization, with its additional ordering and conflict machinery.

<a id="decision-source-policy"></a>

### source and qmd policy

> [!DECISION]
> allow configured native pi session roots and the explicit amp ingress root by default. backup, snapshot, quarantine, conflict, and historical-copy roots require explicit source-kind opt-in.
>
> reject `.stversions`, every descendant of `.stversions`, and every `*.sync-conflict-*` basename before source registration.
>
> qmd consumes only the verified local qmd-source projection of the accepted Git head. `.stversions`, `*.sync-conflict-*`, untracked files, proposal branches, and local workflow artifacts are always excluded regardless of future collection configuration.
>
> the reserved `.pi-memory/**` subtree contains canonical audit evidence but is never a catalog entry, qmd document, retrieval result, prompt input, or telemetry payload.
>
> conflict files are integrity evidence that hosts disagreed, not alternate knowledge inputs.

<a id="decision-storage"></a>

### storage

> [!DECISION]
> keep workflow records, proposals, artifacts, indexes, projections, and Git object storage file-backed.
>
> use deterministic paths, sharding, content addressing, atomic replacement, fsync, short local locks, and idempotent reconciliation. sqlite is not an automatic fallback and requires a new explicit decision.

<a id="decision-slo-budgets"></a>

### model concurrency and resource limits

> [!DECISION]
> permit one active model invocation per host across reflection, critic, corpus-doctor, and tier workflows.
>
> model work on different hosts may overlap because it produces isolated proposals. canonical mutation remains globally serialized by remote Git.
>
> all other exact resource values are implementation tuning, not user approval gates. the architecture requires finite work turns, streaming reads, finite memory and queues, bounded hints and proposal backlog, serialized writers for mutable targets, short checkout locks, and durable continuation whenever a limit is reached.
>
> shadow and natural-corpus measurements select versioned defaults for each host profile. before calibration, finite bootstrap caps derived from valid fixtures and the observed corpus remain mandatory; no resource may be configured as unbounded.
>
> the user-visible effect is that very large work may finish over several turns or queue briefly instead of making the host sluggish, exhausting memory or disk, or blocking canonical access.

<a id="decision-retention"></a>

### canonical retention and runtime telemetry

> [!DECISION]
> retain accepted Git commits, every historical canonical memory version, and commit-encoded history-verification receipts indefinitely. corrections are new compensating commits; accepted history is never rewritten or expired.
>
> accepted canonical evidence consists of the memory version, mutation receipt, accepted admission summary, and bounded safety-filtered claim-bearing capsule in the same Git history. digests of disappearing host-local artifacts are lineage metadata, not sufficient retained evidence.
>
> a memory that cannot retain safe sufficient support does not merge. it may be rewritten into a narrower supportable claim; neither automatic nor manual admission may waive this boundary.
>
> keep nonterminal workflows, pending or blocked proposals, unmerged candidate refs, and every referenced artifact until the work reaches a safe terminal state. terminal workflows, expired proposals, model outputs, replay evidence, rebuildable projections and indexes, local jsonl, and Axiom events are noncanonical operational data with separate cleanup policies.
>
> Axiom receives one bounded, redacted context-rich event per significant operation through the OpenTelemetry collector. it contains runtime observability data only—not canonical memory, prompts, memory bodies, secrets, or workflow recovery state.
>
> local jsonl is a finite delivery buffer. acknowledged data is removed first; a hard cap may discard the oldest unacknowledged telemetry during a prolonged outage, but must report the gap and must not block memory work. active pending-operation markers are never evicted through telemetry rotation.
>
> Axiom duration is a cost/privacy setting owned by the documented dataset or account policy, not a memory-retention or correctness decision. host-local cleanup defaults come from report-only natural-corpus measurement and may activate only after active-reference protection and rebuild checks pass. no further user architecture decision is required.

<a id="decision-model-retry"></a>

### model timeout and retry policy

> [!DECISION]
> use a 120-second per-call timeout and at most three attempts with delayed jittered backoff near 1, 5, and 30 minutes. honor a valid provider `retry-after`.
>
> retry rate limits, transient unavailability, interrupted audited sessions without recovered output, and timeouts. do not retry schema-invalid output, safety rejection, stale basis, unsupported configuration, or a closed admission decision without a new basis or explicit remediation.

<a id="decision-proposal-expiry"></a>

### pending-proposal expiry and re-review

> [!DECISION]
> expire a pending proposal after 30 days or immediately when its source evidence, target artifact, catalog basis, prompt-policy version, model-policy version, or admission-policy version becomes incompatible.
>
> retain a host-local expired summary under the local evidence policy and require a newly bound proposal rather than silently refreshing the old record. proposal expiry never removes accepted canonical history.

<a id="decision-canonical-admission"></a>

### canonical admission

> [!DECISION]
> do not require proof that a memory improves a future task. memory represents durable, evolving knowledge of what happened across agents.
>
> canonical admission requires provenance, honest epistemic classification, safety, structural validity, expiry compatibility, and deterministic convergence. missing or incompatible evidence closes merge readiness while maintenance and proposal generation continue.
>
> every new or materially changed claim must map to bounded, safe, claim-bearing evidence retained in the accepted Git commit. a digest or admission assertion without those supporting bytes is not enough.
>
> paired replay, retrieval labels, usefulness judgments, task delta, and recall remain diagnostic inputs for retrieval and prompt tuning. they do not determine whether a well-provenanced event belongs in memory.

<a id="decision-source-mutation"></a>

### historical source mutation guarantee

> [!DECISION]
> configured trusted pi and amp session producers may be treated as append-only and use the bounded continuity append fast path.
>
> the fast path verifies the saved boundary near the accepted cursor and validates every appended record against the accepted session and graph indexes. it guarantees valid incremental continuation, direct parent and duplicate checks, and crash-safe projection publication.
>
> it does not reread the complete accepted prefix and therefore does not guarantee immediate detection of an arbitrary earlier edit that leaves filesystem identity and the checked boundary compatible.
>
> non-append evidence, untrusted source kinds or producers, truncation, replacement, metadata-only change, failed continuity proof, incompatible policy, or invalid graph assumptions select complete stable streaming validation. invalid or unstable input is quarantined rather than accepted.

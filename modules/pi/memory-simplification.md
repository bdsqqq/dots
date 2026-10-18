# pi memory simplification

## intent — authority for every issue and adapter

preserve automatic memory; simplify its machinery. use pi normally: authorized experience is retained, useful memories arrive without a ritual, and background learning survives closing the session. pi owns this; T3 is an adapter, not a dependency. learning maintains external knowledge, not model weights.

user direction, verbatim:

> “our memory extension becomes the machinery for all the things that need to happen in pi’s turns.”
>
> “they’d task a sub-agent to do it not because there’s a tool telling them to, or specifically for memory, but because that’s what they’d do anyways when searching repos or a codebase.”
>
> “our memory maintainer and such would be some separate process or routine, colocated in our codebase, but independent of  a given agent session surviving.”
>
> “that would only run given enough new stuff to reconcile”
>
> “contracts first, with handlers implementing a contract, and those being exposed through our extensions for different interfaces.”
>
> “our handlers should follow suit, letting us consume the same logic in however shape we want, granted we bring an adapter that implements the contract.”
>
> “tests to prove behavior invariants, NOT testing our own mocks, or contracts the typesystem itself provides.”

### behavior, not implementation quotas

- **meaningful experience:** retain particulars, people, possessions, opinions, decisions, disagreements and reasons—not only coding lessons. no future-task-uplift gate or routine human approval queue. distinguish producer statements, tool observations and model deductions; summaries/assistant echoes are not independent evidence.
- **asynchronous recall:** inference progresses while discovery/retrieval waits. deliver bounded, source-linked native context without a memory-tool ritual. silent empty results; authenticated, deduplicated, scope/expiry/suppression/obsolescence-checked delivery. bodies are request-local, not baked into compaction; preserve ordinary summaries/history and ordinary investigation tools/subagents.
- **independent background progress:** capture, eligible consolidation and replication must not hold each other hostage. thresholds, corrections, pending age and recovery trigger thinking; empty queues never do. retain early/oversized UTF-8 spans and durable accepted/no-change/ineligible/retry outcomes, with backoff and restart recovery.
- **local ownership:** editable concise linked Markdown, permanent note IDs distinct from revision hashes, rename-safe links, preserved competing/unknown ancestry. offline durability never waits for Git or remote ACK. preserve unpublished/program-written edits. indexes are rebuildable; evidence/ancestry/suppression history is not. unsynced changes can be lost with a machine.
- **authority and forgetting:** current repository facts beat dated experience; memory grants no permission. observed project scope may narrow personal evidence, never widen restricted evidence. suppression constrains new admission/relearning/delivery, not retroactive conversation/summary/history/backup erasure. permanent deletion and real legacy imports require separate authorization.
- **shared capability:** typed handlers serve SDK, headful/headless CLI, JSON, extensions and codemode through thin adapters. supplied data/configuration bypass rediscovery/refetch. preserve native session IDs, settings/auth and unrelated keys. defaults compose the same parts callers may replace; no parallel implementation, duplicated schema or generic plugin/job framework.

### concurrency and lifetime contracts

SQLite is short local coordination, not a global lock around retained-history traversal, hashing/fsync, materialization, models or SSH. prepare I/O concurrently; retain correct conditional acceptance, lease fencing and version-preserving placement across crashes/edits. moving effects outside serialization requires a proven replacement boundary. locally accepted, indexed, queued and delivered remain distinct states.

foreground eligibility latency, network liveness, evidence leases and background lifetime are DIFFERENT contracts. a minute timer wakes work; it is not an execution allowance. remove arbitrary whole-maintenance/model kills rather than shrink retention to fit them. long model work owns a renewable logical lease, not a held database transaction; lost/expired owners cannot accept late output. explicit shutdown cancels cooperatively and preserves recoverable progress. necessary limits follow the operation/caller policy, not an unsupported global number.

reuse native supervisors/I/O adapters where sufficient. independent progress does not prescribe another daemon, scheduler or sync library. justify machinery by an invariant and actual consumers. SSH is the current transport, not a user requirement. configured authenticated peers exchange authorized causal data, never host-local leases/inboxes/indexes; concurrent alternatives do not establish factual agreement.

### R0 handoff contracts

- preserve `MemoryStore.commit`'s conditional durable-acceptance results; preparation/snapshots/placement stay internal unless a real caller needs a public capability. no partial acceptance masquerading as success.
- storage owns `renewLease({ lease, now, leaseMs }) -> { kind: "renewed", lease } | { kind: "lease-lost" }`. renewal preserves identity/window ownership, cannot resurrect an expired/lost lease, and accepts no evidence. lifecycle owns heartbeat/current lease and fences late provider results. agree signature refinements before either owner changes dependent code.
- shared reconciliation owns model/lease lifecycle; native adapters own process cancellation/reload, not another reconciliation policy. source caller owns supplied snapshots/identity; worker owns discovery only when requested. foreground eligibility stays fail-closed without blocking inference.
- agreed R0: reuse native launchd/systemd jobs for independent catch-up, reconcile and replicate capabilities. `MemoryApplication.reconcile(signal)` is the shared background handler; existing `maintain` may compose the capabilities, but one rejected phase must not close resources still used by siblings or hide accepted progress. no new scheduler/daemon. source/extension ownership above is confirmed; R3 needs no new storage port. R1 lands the renewal contract first; R2 consumes that named commit. refinements return through primary before dependent edits.

## current evidence — not completion

- deployed `main` is `6a667567`: async contention (`f64cf18a`), production openers (`a0cd1e35`), cold eligibility (`6a667567`). local typecheck/build, source/built CLI and **93 files / 1198 tests passed, 5 skipped**. negative controls detect absent acquisition retry, synchronous dirty opening and over-budget cold checks. these do NOT prove unattended health.
- live service still times out: one measured pass spent **51s capture + 93s consolidation**, reaching replication around 145s before cancellation. cold mutation still confirms retained history/files under the writer reservation. existing 150/155s CLI, 90s reconciliation and 180s Linux service limits are choices to reassess, not requirements.
- [publication CI](https://github.com/bdsqqq/dots/actions/runs/39149425166) failed legacy concurrent-identity and source-CLI startup timeouts. no new package-publication claim. local tests use two outer workers; CI must account for real subprocess concurrency without weakening assertions.
- mac activation installed live-source wiring; actual Pi paths resolve to `modules/pi`, NOT `~/.local/share/t3-pi` (T3 server). peer errors/fleet convergence remain unresolved. no private legacy import ran. discarded the unshipped four-window/peer-parallelism workaround. historical M0–M7 tests are evidence in Git, not current production acceptance.

## project — finish the simplification in production

primary owns contracts, queue, integration and release. every delegate reads this WHOLE file at its starting commit and before handoff; only primary edits it. `[ ]` means unfinished. dependent implementation waits for its named port/commit; independent design/tests may proceed. substantial slices use isolated worktrees, not overlapping checkouts.

| issue | outcome / exclusive owner and writable scope | dependencies | observable acceptance | state |
|---|---|---|---|---|
| R0 | freeze ownership, cancellation, renewal and acceptance contracts; primary, plan/integration | — | storage/lifecycle/adapter owners agree ports before dependent code; no deadline-fitting experiment | complete — owner agreement recorded below |
| R1 | short storage coordination; storage agent, `runtime/{contracts,store,durability}.ts` | R0 | real processes with representative retained payloads capture/read/edit concurrently; stalled preparatory I/O reserves no DB writer; no caller-only retry; stale/partial acceptance refused; crash/restore, unknown edits, suppression, durability and rollback proofs preserved | active — storage agent; renewal port first |
| R2 | session-independent background lifetime; lifecycle agent, `runtime/{application,cli,reconcile,model}.ts`, `modules/pi-memory/default.nix` | R0; R1 renewal port | long model work exceeds former limits while capture/sync progress; renewal/reclaim fences late output; empty/backoff means zero thinking; shutdown/restart loses no work; no quota compensates for a deadline | active — lifecycle agent; renewal dependency pending |
| R3 | native source/foreground parity; adapter agent, `runtime/{catch-up,pi-source,session-worker}.ts`, `extensions/agent-memory/index.ts` | R0; R1 ports | real SDK inference proceeds with stalled backends; useful automatic context with representative retained payloads; suppression/forgery/compaction invariants; concurrent live/disk capture retains early/late spans; supplied snapshots never refetch | active — adapter agent; representative regressions |
| R4 | independent, diagnosable peer progress; primary, `runtime/{replica,replica-transport,peer-auth}.ts` | R0, R1, R2 | unavailable peer gates neither learning nor healthy-peer progress; process replicas preserve edits/deletes/ancestry, suppression, restored checkpoints and authorization; errors identify boundary without private payloads; no foreground ACK dependency | queued |
| R5 | integrated craft/behavior proof; primary + bounded reviewer, tests/docs/CI/root exports | R1–R4 | same handlers through source/built SDK/CLI/JSON/extension; inert imports and preserved settings/auth/edits; known failures detected; full suite/provider-builder passes at tested revision; no redundant framework/catalog/default legacy gate | queued |
| R6 | land and verify actual installation; primary, release/native wiring/record | R5 | signed incremental commits on `main`, CI/registry artifact matches source, live dependencies/reload/apply checked; concurrent recording and long consolidation work; configured-peer health reported honestly; permission/offline blockers never marked complete | queued |

### working agreement — every agent

1. load `designing-progressive-apis`, `composing-data-driven-ui` (ownership/handlers, not React scaffolding), `shaping-and-shipping-software`, `desloping-code-changes`, `document`, `write`, `git`, plus task-specific skills/references. read repository and `modules/pi/AGENTS.md`; read complete installed Pi SDK/extension docs and relevant cross-references before changing those APIs.
2. contracts first: show default and caller-owned-data/dependency calls; define inputs/results/ownership/cancellation, then shared handlers and adapters. coordinate new ports through primary; no local lookalike contract, hidden refetch or competing owners.
3. prove outcomes with real isolated files, processes and SDK sessions. fake only external model/network/clock boundaries as needed; use controlled stalls/clock progression, not minutes of sleeping. do not assert our mocked calls or re-test TypeScript. runtime validation tests exercise external boundaries. new verifiers require isolated known-failure sensitivity; broken fixtures do not count.
4. incrementally commit verified owned paths, signed `type(pi/memory): ...`; no squash/amend/force push/`git add -A` or unrelated cleanup. delegates never push/merge/deploy, alter installed skills, migrate private data, read live notes/raw sessions/auth or probe production providers/SSH merely to test. primary owns authorized release/normal operational verification; no new enrollment/widened grants.
5. typecheck + targeted inline vitest; build for exports/dist/manifest, frozen install for dependencies. Nix wiring requires native evaluation/consuming artifact checks; deployment follows repository host-build policy. distinguish parsed/typechecked/evaluated/built/runtime-tested; types/artifacts do not replace behavior.
6. use the brief's budget; after two failed attempts change approach/report a blocker. no repeated clean-review ritual. hand off host/worktree, commits/tested artifact, active/blocked/review-ready state, findings/counterevidence, gaps and next action. primary traces findings and verifies integration. a status update, small green fixture or installed timer is not completion.

### preserved boundaries / evidence

keep explicit legacy `propose/proposals/show/review/history verify` and project-proposal consumers until migrated; installed remember-skill edits/real imports are excluded. `38871600` guards native data from legacy whole-root replacement. qmd remains a legacy projection, not a native semantic index. default special memory tools/frozen catalogs stay retired. research reproduction rights are separate.

preserve native identity/UTF-8 coverage (`de57e479`, `feb92194`), lifecycle/producer attribution/historical suppression (`8c9aef4f`, `37121090`), authenticated neutral markers/request-local context (`007e790c`), restored receipts/project backlog (`805fe52e`), and continuity-fenced dependency-authorized replication (`5eb950ad`, `416995a7`, `0d296178`, `6170e0fa`). no physical-power-loss, semantic-quality, retroactive-erasure or fleet guarantee follows. [runtime rationale](packages/core/agent-memory/runtime/README.md); [historical assessment](packages/core/agent-memory/simplification-assessment.md) is superseded where it recommends manual memory.

### closing evidence — primary updates after execution

baseline production/publication failures remain OPEN. record integrated commits, checks/negative controls, live observations and actual publication/activation here. never close an issue because a library exists, a mock was called, or a job exited zero while an agreed phase failed.

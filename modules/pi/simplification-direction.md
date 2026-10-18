# pi simplification direction

recorded 2026-10-17 from the user's feedback after the extension inventory.
the P0–P6 project below is historical. the user's subsequent automatic-memory
choice and implementation contract live in [pi memory simplification](memory-simplification.md).
live-data and activation boundaries remain explicit.

## simplify before considering a durable port

the next question is which capabilities deserve to survive, not how to port
every existing extension to pi durable. prefer existing project commands,
ordinary executable tools, native pi capabilities, and small programmatic
interfaces over custom extension machinery.

keep the broader [agent setup direction](../../agent-setup-direction.md):
T3 owns interaction and execution; this repository provisions useful
capabilities. simplification is not a proposal to build another assistant,
conversation store, or orchestration framework.

## user directions

### retire the generic formatter tool

`format_file` guesses a formatter from the environment, while projects own their
formatting conventions and commands. agents should inspect project guidance and
scripts such as those in `package.json`, then run the appropriate project
command. do not replace the extension with another generic formatter selector.

### prefer shell tools for file discovery and text search

`glob` (which registers `find`), `grep`, and `ls` can reasonably give way to
direct bash use. put useful defaults in the executables or their configuration
where appropriate. interactive shell aliases alone are not a reliable interface
for noninteractive agent processes.

`read` remains a possible exception: image/binary handling gives it a reason
to exist beyond displaying text. retaining it is provisional, not a decision
to preserve the entire current implementation.

### retire the exposed undo tool and reconsider the custom editing subsystem

the user considers `undo_edit` unnecessary: agents have other ways to reverse
their own edits.

the user also questioned the value of our custom validation/rollback machinery.
do not treat preserving snapshots, multi-file rollback, change IDs, and
session-bound undo tracking as a prerequisite for simplification.

the proposed replacement is native pi edit/write tools or standard patch
tooling, followed by project-specific checks, diff inspection, and ordinary
repairs. basic behavior already supplied by a tool, such as refusing a
nonmatching edit, is different from maintaining our own transaction subsystem.
this project selects native pi edit/write, not another custom patch tool.

preserving unrelated user edits remains a working constraint. it does not
require a custom undo ledger or blanket permission to discard a working tree.

### replace session wrappers with programmatic access where useful

session-management and history tools are candidates for replacement by pi SDK
snippets or a small interface callable from codemode, rather than one extension
per operation.

indexed retrieval may still deserve a separate interface. consider exposing
qmd through codemode or the shell; deliberate transcript searches can also use
`rg`. do not assume SDK operations, indexed search, and raw JSONL reads provide
the same semantics.

keep session and branch identity explicit when an operation depends on them.
do not create another session/history database. deliberate transcript access
is not permission to use raw sessions as a fallback personal-memory source.

### use native session storage instead of bds-pi configuration

prefer one native pi session root per host, retaining its workspace
subdirectories. use the SDK's `SessionManager.listAll()` for unified discovery,
not a copying service, another session database, or a symlink forest.

the 2026-10-17 check found this T3 conversation already under
`~/.pi/agent/sessions/`. the additional `~/.t3/userdata/providers/pi` directory
configured in `modules/agents/bds-pi.json` was absent on both Mac and lab.
that extra path is stale, not evidence of additional history coverage.

check the remaining consumers, remove redundant `sessionsDirs` overrides, and
retire the `bds-pi.json` file and Nix symlink. migrate any surviving custom
options before removing their reader; do not preserve a separate branded
configuration layer just to list session roots.

use pi's native `sessionDir` setting only if another location is genuinely
needed. current observations do not justify moving existing session files or
changing their identities. verify each writer's path selection before any
future relocation.

cross-host discovery is separate from local storage. prefer a read-only search
view over Mac and lab sessions rather than bidirectionally synchronizing active
session files.

### remove the cmux-specific integration

the user no longer uses cmux. `cmux-notify` no longer has a useful integration
target and is a retirement candidate, not something to port to another backend.

### reconsider whether agent memory is needed

`agent-memory` belongs in the "rethink whether we need it" bucket. do not assume
that automatic injection, exposure receipts, background maintenance, or a
replacement memory system must survive.

an alternative to evaluate is explicit guidance plus searchable notes.
this is not yet a decision to disable the memory extension, delete memories,
stop its services, or replace its governance pipeline.

## implementation questions, not settled requirements

- the nested-instructions extension currently recognizes particular observation
  and mutation tools. shifting activity into bash does not automatically retain
  instruction discovery or those barriers. decide the desired behavior
  explicitly; do not silently assume the current mechanism must survive, or
  claim equivalent protection without checking it.
- decide which session operations need a narrow API, which indexed retrieval
  remains useful, and which can be ordinary shell/SDK work.
- decide whether `read` should remain, be reduced, or be replaced by native pi
  behavior plus dedicated binary/image handling.
- decide whether any automatic memory behavior earns its complexity before
  designing a replacement.
- child-agent roles, other TUI features, lifecycle controls, and the remaining
  extensions have not been individually approved for retention or removal.

## pi durable is a separate decision

the inventory compared our coding-agent 1.1.0 extensions with the experimental
pi durable 1.3.0 source at
[`8efd314fa3`](https://github.com/earendil-works/pi/tree/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/durable).
that was a static compatibility assessment, not a tested migration.

do not turn its port categories into a backlog to preserve everything. first
reduce the useful surface. consider a narrow durable integration only if a
concrete workflow needs crash recovery and a verified host boundary preserves
the intended T3 experience.

durability does not make arbitrary shell commands, file writes, model calls, or
external requests safe to repeat. this does not justify rebuilding the custom
transaction machinery the user just questioned.

## implementation contract

the user's words govern the architecture:

> "contracts first, with handlers implementing a contract, and those being exposed through our extensions for different interfaces."

> "our handlers should follow suit, letting us consume the same logic in however shape we want, granted we bring an adapter that implements the contract."

handlers own behavior and explicit dependencies; adapters own interface-specific
input, presentation and lifecycle. reuse pi's existing SDK contracts before
inventing ours. support direct SDK/headless use and thin extension/codemode
adapters from the same logic; do not build every possible interface in advance.
supplied data must not trigger another read. preserve explicit session/branch
identity, cancellation, errors and authority across interfaces.

> "tests to prove behavior invariants, NOT testing our own mocks, or contracts the typesystem itself provides."

use real temporary files and SDK sessions to prove outcomes, direct/adapted
parity, isolation and failure behavior. mock only external boundaries when
needed. no callback-spy, registration-count or redundant type-shape tests as
acceptance evidence. tests must fail for the behavioral regression they guard.

## project: a smaller pi surface

> "the plain text bit describes intent and general goals, the project bean count provides ordering and a way for you to effectively delegate."

the table is the shared queue, not another tracker. parent owns its status,
integration files and final verification; agents commit only their owned slice.

| issue | outcome / owner | depends on | status |
|---|---|---|---|
| P0 | agree contracts, scope and evidence / parent | — | done |
| P1 | native editing + shell discovery; retire redundant tools / tools agent | P0 | done |
| P2 | shared SDK session handlers + thin codemode adapter / sessions agent | P0 | done |
| P3 | native configuration; remove bds-pi roots/wiring / config agent | P0; integrate after P2 | done |
| P4 | assess automatic memory need without deleting data / memory reviewer | P0 | done; product choice open |
| P5 | integrate consumers, exports, manifests, lockfile and guidance / parent | P1, P2, P3; P4 verdict | done |
| P6 | adversarial craft review, behavioral checks, incremental main landing / parent | P5 | done |

### issue acceptance

- **P1:** remove custom `format_file`, `undo_edit`, `apply_patch`, `find`,
  `grep`, `ls`, and cmux integration. native edit/write handle edits; project
  scripts handle formatting; bash runs search/listing binaries. remove unused
  transaction/undo machinery, not unrelated utility code. preserve binary/image
  reading for now. prove native edits preserve unrelated contents, nested
  instructions still gate known edits (including nested dispatch), and shell
  discovery works on real fixtures. no claim of parsing arbitrary bash safely.
- **P2:** replace model-spawning session readers/search wrappers and duplicated
  session implementation with SDK-backed list/read capabilities. direct callers
  and codemode share handlers; use real branched sessions to prove identity,
  ordering, selected-branch reads, ambiguity/errors and supplied-data behavior.
  indexed retrieval stays with existing qmd; deliberate text search can use rg.
- **P3:** remove the tracked bds-pi root list and Nix link, migrate surviving
  custom settings to native pi settings without discarding mutable overrides.
  prove default/custom native session roots and configuration precedence against
  real fixtures. do not move live sessions or change their IDs.
- **P4:** give a source-backed keep/reduce/retire recommendation for automatic
  memory integration. "rethink whether we need it" is not permission to delete
  memories or stop governed services; record unresolved product choice honestly.
- **P5:** no active references to retired tools; discovery/build outputs agree.
  update child allowlists and prompts, not only registrations. no generic
  replacement framework or mandatory durable migration.
- **P6:** run affected SDK/type/tests and build; evaluate affected Nix hosts and
  build changed activation artifacts where applicable. review behavior, not just
  green tests. land small signed commits/PRs; preserve unpublished work and native
  mutable configuration. no activation, service interruption or live-data
  migration merely for verification.

### agent working agreement

read this file and applicable `AGENTS.md` before implementation. load
`designing-progressive-apis`, `shaping-and-shipping-software`,
`desloping-code-changes`, `document`, `write`, and `git`; use
`composing-data-driven-ui` for the supplied-data/adapter ownership pattern
(apply the principle, not React scaffolding). load other skills only as relevant.
commit incrementally with evidence; report commit IDs, checks and gaps.
no overlapping shared-file edits, force pushes, broad staging or silent scope
expansion. two failed attempts on an approach require changing it or reporting
the blocker. implementation agents do not push/merge unless explicitly assigned.

### completion evidence — 2026-10-17

runtime verification below covers `6cd085b5`; subsequent changes only document
the result. the packaged manifest now has 25 entries, down from 33. native
edit/write remain available beside codemode; retained transcript rendering does
not register retired tools.

- `pnpm exec vitest run --maxWorkers=2`: **80 files, 1108 passed, 5 skipped**.
  real fixtures cover edit preservation/barriers, SDK branches and identity,
  grouped/flat roots, legacy reads, settings and mailbox provenance.
- frozen install, `tsc -p tsconfig.build.json --noEmit`, and `pnpm run build`
  passed. source/built manifests agree. install still reports dependency
  deprecation/peer warnings; no warning-free release is claimed.
- `node scripts/check-codemode.ts`, with and without `--built`, passed through
  the actual CLI. both `--negative` variants detected unrelated-text clobber.
  external network/model replies are fixtures, not live-service evidence.
- `PI_TEST_BUILT_TOOLS=1 pnpm exec vitest run --maxWorkers=2
  packages/core/prompt-patch packages/core/pi-spawn/index.ts`: **73 passed**,
  including provider wire parity and native child-tool execution.
- agent guidance checks/typecheck passed: **32 tests**, no errors, eight
  supporting archival-link warnings. no model routing evaluation was run.
- `nix eval --raw --no-write-lock-file
  .#darwinConfigurations.mbp-m2.system.drvPath` passed; the affected
  `darwinConfigurations.mbp-m2.config.home-manager.users.bdsqqq.home.activationPackage`
  was built with `nix build --no-link --no-write-lock-file`.
  no full host build, Linux runtime check, activation or live-session reload.

adversarial review exposed ephemeral-root loss, prefix-identity replacement,
legacy v1 rejection and grouped-versus-flat discovery confusion. repairs include
regression checks; actual CLI verification caught the grouped discovery mistake
that path-only checks missed. standalone memory CLI execution also caught a
missing workspace dependency, now declared. baseline fixture fixes canonicalize
macOS temp paths and allow process startup/durable-write latency without changing
runtime policies or timeouts.

see the [history contract and SDK limitations](packages/core/sessions/README.md)
and [native settings import procedure](packages/core/config/MIGRATION.md).
Mac and lab had no mutable `bds-pi.local.json`; no settings import, session
relocation or auth change was needed. local SSH signature verification remains
unavailable without `allowedSignersFile`; signatures are embedded.

the [memory assessment](packages/core/agent-memory/simplification-assessment.md)
recommended deliberate search as a hypothesis, not a measured usefulness result.
the user subsequently chose automatic Pi-owned capture, asynchronous recall and
independent backlog reconciliation; [the follow-up plan](memory-simplification.md)
supersedes that memory recommendation. pi durable remains a separate project.

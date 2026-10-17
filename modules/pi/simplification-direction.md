# pi simplification direction

recorded 2026-10-17 from the user's feedback after the extension inventory.
this records direction, not completed implementation or authorization to remove
the features below.

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
the exact editing interface remains to be selected.

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

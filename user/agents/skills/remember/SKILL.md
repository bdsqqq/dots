---
name: remember
description: "record context that would help in future sessions. use after learning something, discovering a gotcha, or making a decision worth preserving. test: would a future agent starting fresh benefit from knowing this?"
---

# remember

record memories for future retrieval. files are the source of truth; qmd is the search index, with grep as the exact-match fallback.

## configuration

set `$MEMORY_ROOT` to your memory directory:

```bash
export MEMORY_ROOT="$HOME/commonplace/01_files/_utilities/agent-memories"
```

if unset, defaults to `~/commonplace/01_files/_utilities/agent-memories/`. customize paths in examples below to match your setup.

## when to use

- learned something that would help in future sessions
- discovered a pattern or gotcha worth preserving
- captured context that will otherwise be lost when this thread ends
- built something worth documenting for reuse

## memory anatomy

memories follow date-prefixed naming with two agent-specific requirements:

1. **`source__agent` tag** — required, marks this as agent-generated
2. **frontmatter with thread URL** — records where learning happened

```
$MEMORY_ROOT/YYYY-MM-DD description -- source__agent.md
```

```yaml
---
source: https://example.com/session/T-xxxxx
keywords:
  - relevant
  - searchable
  - terms
---
```

`keywords` are freeform tags for retrieval.

## content

write for your future self:

- the insight
- why it matters
- how to apply it

link to related memories with markdown links: `[note name]($MEMORY_ROOT/note name.md)`

belief: connections between ideas compound value. an isolated fact is less useful than one linked to context.

## examples

### pattern learned

date-prefixed naming makes chronological browsing trivial. insight in body, not filename:

```markdown
# kanata timing on macos

homerow mods feel laggy with default timing. 150ms tap timeout + 250ms hold
works well. the `charmod` template with fast-typing detection prevents
misfires during rapid typing.

key insight: smart typing detection (`key-timing 3 less-than 250`) disables
homerow mods when typing fast, re-enables when pausing.
```

### gotcha discovered

gotchas prevent repeat debugging sessions:

```markdown
# nix overlay ordering

overlays apply left-to-right. if overlay B depends on packages from overlay A,
A must come first in the list. this bit us when unstable overlay wasn't
available to later overlays.

fix: ensure `unstable.nix` is first in the overlays list.
```

### decision recorded

decisions capture the tradeoffs considered, not just the choice made:

```markdown
# chose grep over sqlite for memory retrieval

considered basic-memory (sqlite + vectors) but it kept corrupting on sync.
grep on flat files is:

- unbreakable (files are source of truth)
- syncthing-friendly
- human-readable
- fast enough for thousands of files

tradeoff: no semantic search. acceptable given good naming/tagging.
```

## retrieval

retrieve memory when the current task signals a dependency on prior work, preferences, decisions, or missing historical context. skip retrieval when current context fully specifies the task. search at most once per coherent work unit, then reuse the result until the topic changes.

```bash
# ranked search, when qmd is installed and indexed
(cd "${MEMORY_ROOT:-$HOME/commonplace/01_files/_utilities/agent-memories}" && qmd search -c agent-memories "topic" -n 10)
(cd "${MEMORY_ROOT:-$HOME/commonplace/01_files/_utilities/agent-memories}" && qmd get "qmd://agent-memories/file-name.md" --full)

# refresh the lexical index after adding/editing memories
(cd "${MEMORY_ROOT:-$HOME/commonplace/01_files/_utilities/agent-memories}" && qmd update)

# exact fallback when qmd is unavailable or misses literal terms
rg "topic" "${MEMORY_ROOT:-$HOME/commonplace/01_files/_utilities/agent-memories}"/*source__agent*.md

# recent memories
ls -t "${MEMORY_ROOT:-$HOME/commonplace/01_files/_utilities/agent-memories}"/*source__agent*.md | head -20
```

use `pi-sessions` for episodic history rather than durable guidance:

```bash
qmd search -c pi-sessions "what happened" -n 10
```

## background reflection

pi checkpoints completed branches, then groups ancestor checkpoints into branch-safe windows. reflection receives authored text plus redacted tool outcome counts; reasoning, tool arguments, and raw tool output are excluded. it compares evidence with active memory and pending proposals, but background work stops at a reviewable proposal.

```bash
pi-memory project
pi-memory consolidate --limit 10
pi-memory maintain

# inspect pending memory and skill proposals
pi-memory proposals --status pending
pi-memory show prop_id

# every review requires a reason
pi-memory review prop_id accept \
  --reason-code correct --reason "captures the durable constraint"
pi-memory review prop_id reject \
  --reason-code duplicate --reason "already covered elsewhere"

# accepted memory changes are hash-guarded and reversible
pi-memory rollback review_id --reason "later shown incorrect"
```

memory proposals can create, update, merge, archive, or retire flat markdown notes. accepted skill proposals become draft bundles under `~/.local/share/pi-memory/v2/approved-skills`; pi-memory NEVER edits installed skills. install a draft only through the normal code-review, test, and git workflow.

`pi-memory catalog` shows the bounded pointer catalog injected into agent prompts. full contents remain on-demand through qmd/grep. `pi-memory metrics` reports pipeline activity without pretending acceptance is a quality reward.

```bash
# one-time, non-destructive import of legacy candidates
pi-memory migrate --dry-run
pi-memory migrate

# build and replay a local reviewed-example dataset
pi-memory eval export --out ~/.local/share/pi-memory/eval/reviewed-v1.jsonl
pi-memory eval replay --dataset ~/.local/share/pi-memory/eval/reviewed-v1.jsonl \
  --modes memory-off,current,gold --limit 20
```

generated workflow state lives under `~/.local/share/pi-memory/v2`; retry and cadence state lives under `~/.local/state/pi-memory`. active markdown remains the source of truth.

## what NOT to remember

- session-specific context (use thread continuation instead)
- things already documented elsewhere (link instead)
- trivial facts (not worth the file overhead)

---
name: remember
description: "record context that would help in future sessions. use after learning something, discovering a gotcha, or making a decision worth preserving. test: would a future agent starting fresh benefit from knowing this?"
---

# remember

record memories for future retrieval. submit through `pi-memory`; never write memory markdown directly. memory changes commit autonomously with receipts, private git history, and rollback support.

## configuration

the active memory root defaults to:

```bash
export MEMORY_ROOT="$HOME/commonplace/01_files/_utilities/agent-memories"
```

`pi-memory` owns mutations inside this directory. read it for retrieval, but use `pi-memory propose`, `rollback`, or `repair` for changes.

## when to use

- learned something that would help in future sessions
- discovered a pattern or gotcha worth preserving
- captured context that will otherwise be lost when this thread ends
- built something worth documenting for reuse

## memory anatomy

memory submissions declare `title`, `kind`, `scope`, `description`, `triggers`, `keywords`, and `body`. `pi-memory` assigns identity, filename, dates, provenance, mutation receipt, and git commit.

submit one strict JSON payload:

```bash
pi-memory propose --source "pi://${PI_SESSION_ID:-manual}" --json '{
  "action": "propose",
  "proposals": [{
    "lane": "memory",
    "operation": {
      "type": "create",
      "artifact": {
        "title": "concise durable title",
        "kind": "pattern",
        "scope": "global",
        "description": "Use when this guidance applies",
        "triggers": ["concrete trigger"],
        "keywords": ["searchable", "terms"],
        "body": "The durable insight, why it matters, and how to apply it."
      }
    }
  }]
}'
```

valid kinds: `preference`, `decision`, `gotcha`, `pattern`. prefer project scope for repository-specific guidance and `global` only for cross-project behavior. memory submissions apply immediately; executable skill drafts remain review-gated.

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

# refresh the lexical index after accepted mutations
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

pi checkpoints completed branches, then groups ancestor checkpoints into branch-safe windows. reflection receives authored text plus redacted tool outcome counts; reasoning, tool arguments, and raw tool output are excluded. it compares evidence with active memory and pending proposals, then autonomously commits memory changes through the same receipt-backed transaction engine. executable skill drafts remain pending.

```bash
pi-memory project
pi-memory consolidate --limit 10
pi-memory maintain

# inspect pending skill drafts or deferred memory conflicts
pi-memory proposals --status pending
pi-memory show prop_id

# autonomous memory changes are hash-guarded and reversible
pi-memory rollback review_id --reason "later shown incorrect"

# inspect receipt-backed private git history
pi-memory history list --limit 20
pi-memory history show HEAD
pi-memory history diff
pi-memory history verify
```

autonomous memory mutations can create, update, merge, archive, or retire flat markdown notes. accepted skill proposals become draft bundles under `~/.local/share/pi-memory/v2/approved-skills`; pi-memory NEVER edits installed skills. install a draft only through the normal code-review, test, and git workflow.

`pi-memory catalog` shows the bounded pointer catalog injected into agent prompts. full contents remain on-demand through qmd/grep. `pi-memory metrics` reports pipeline activity without pretending acceptance is a quality reward.

```bash
# one-time, non-destructive import of legacy candidates
pi-memory migrate --dry-run
pi-memory migrate

# build and replay a local reviewed-example dataset
pi-memory eval export --out ~/.local/share/pi-memory/eval/reviewed-v1.jsonl
# replay explicitly invokes the configured model with sanitized cases
pi-memory eval replay --dataset ~/.local/share/pi-memory/eval/reviewed-v1.jsonl \
  --modes memory-off,current,gold --limit 20 --allow-model-invocation
```

generated workflow state and the private git database live under `~/.local/share/pi-memory/v2`; retry and cadence state lives under `~/.local/state/pi-memory`. github sync is private and retryable. active markdown remains the readable worktree, but direct edits are rejected until explicitly adopted or discarded with `pi-memory repair`.

## what NOT to remember

- session-specific context (use thread continuation instead)
- things already documented elsewhere (link instead)
- trivial facts (not worth the file overhead)

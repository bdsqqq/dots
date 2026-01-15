---
name: remember
description: "record context that would help in future sessions. use after learning something, discovering a gotcha, or making a decision worth preserving. test: would a future agent starting fresh benefit from knowing this?"
---

# remember

record memories to [~/commonplace/01_files/](~/commonplace/01_files/) for future retrieval. no database—files are the memory, retrieved via grep. see the [commonplace README](~/commonplace/README.md) for the full system.

## when to use

- learned something that would help in future sessions
- discovered a pattern or gotcha worth preserving
- captured context that will otherwise be lost when this thread ends
- built something worth documenting for reuse

## memory anatomy

memories follow [commonplace file naming](~/commonplace/README.md#file-naming) with two agent-specific requirements:

1. **`source__agent` tag** — required, marks this as agent-generated
2. **frontmatter with thread URL** — records where learning happened

```
~/commonplace/01_files/YYYY-MM-DD description -- source__agent.md
```

```yaml
---
source: https://ampcode.com/threads/T-xxxxx
keywords:
  - relevant
  - searchable
  - terms
---
```

`keywords` are freeform tags for retrieval. see [frontmatter](~/commonplace/README.md#frontmatter) for conventions.

## content

write for your future self:

- the insight
- why it matters
- how to apply it

link to related memories with markdown links: `[note name](~/commonplace/01_files/note name.md)`

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

check for relevant memories before starting work:

```bash
# find agent memories about a topic
ls ~/commonplace/01_files/ | grep source__agent | grep -i topic

# search memory content
rg "topic" ~/commonplace/01_files/*source__agent*.md

# recent memories
ls -t ~/commonplace/01_files/*source__agent*.md | head -20
```

## what NOT to remember

- session-specific context (use thread continuation instead)
- things already documented elsewhere (link instead)
- trivial facts (not worth the file overhead)

---
name: handoff
description: "Context management via shared summarization. Loaded automatically — teaches the agent when to hand off to a new session vs compact or summarize a branch in-place."
---

# handoff

this environment has three context moves:
- `/handoff` or the `handoff` tool: move to a new session with curated context
- native compaction: compress old context in-place
- `/tree` summarization: keep side-quest learnings when jumping back in the same session

all three use the same dedicated summarizer model family with action-specific prompts.

## what you need to know

- you have ~200k tokens of context. that's plenty, but not infinite.
- at ~85% usage, the extension may auto-stage `/handoff` in the editor as a suggested escape hatch.
- native compaction is enabled again. it is lossy, but it no longer falls back to pi's stock prompt.
- `/tree` summaries are now handoff-style notes to your future self inside the same thread.

## your responsibilities

1. **keep threads focused.** one task per session unless a branch genuinely helps.
2. **pick the right move.** use handoff for a new thread, `/tree` for an in-thread side-quest, compaction when staying put is fine.
3. **be aware of context usage.** lots of file reads, tool calls, and back-and-forth means summarization risk is rising.
4. **front-load investigation.** read what you need early, then stop re-reading the same stuff.

## invoking handoff

you have a `handoff` tool. call it directly when a fresh session is the right boundary:

- context is getting heavy and the next task is clear
- you've completed a unit of work and want a successor thread
- you're about to start a materially different task

```
handoff({ goal: "implement the auth middleware we planned" })
```

the tool generates a handoff prompt via the summarizer, stages `/handoff`, and lets the user review before switching.

the user can also run `/handoff <goal>` manually.

## what happens during handoff

1. conversation is serialized and sent to the dedicated summary model
2. the model is forced to call `create_handoff_context`
3. code assembles: session link → @file refs → first-person context bullets → goal
4. a new session is created with `parentSession` linking to the old one

## session tools

you have two tools for previous-session lookup:

### read_session

read a previous session's conversation by ID. use it when a handoff prompt references a session and you need fuller detail.

### search_sessions

search sessions by text. use it to find old work before calling `read_session`.

## after handoff

you do NOT inherit the old session's raw messages. the handoff prompt is primary context. use `read_session` if you need to drill back in.

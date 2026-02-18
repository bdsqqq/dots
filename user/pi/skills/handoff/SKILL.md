---
name: handoff
description: "Context management via handoff instead of compaction. Loaded automatically — teaches the agent how context works in this environment."
---

# handoff

compaction is **disabled** in this environment. context is managed via handoff — transferring curated context to a new session instead of summarizing in place.

## what you need to know

- you have ~200k tokens of context. that's plenty for focused work.
- at ~85% usage, the handoff extension auto-generates a transfer prompt and stages `/handoff` in the editor. the user just presses Enter to continue in a new session.
- you will NOT be compacted. if you exhaust context, you hit a wall. plan accordingly.

## your responsibilities

1. **keep threads focused.** one task per session. don't meander.
2. **be aware of your context usage.** if you've done a lot of tool calls and file reads, you're probably getting heavy. mention it to the user.
3. **when you sense context is getting heavy**, tell the user: "context is getting heavy — might be a good time to `/handoff` with the next task."
4. **front-load investigation.** read what you need early, make decisions, then execute. don't re-read files you've already seen.

## manual handoff

the user can run `/handoff <goal>` anytime to transfer context to a new session with a specific goal. the extension generates a curated prompt with context summary, relevant files, and the stated task.

## what happens during handoff

1. conversation is serialized and sent to the LLM for summarization
2. a focused prompt is generated: context + files + next task
3. a new session is created with `parentSession` linking to the old one
4. the prompt is sent as the first message — you start working immediately

## session tools

you have two tools for accessing previous sessions:

### read_session

read a previous session's conversation by ID. supports partial UUID matching.

- `read_session({ sessionId: "abc123" })` — returns full serialized conversation
- `read_session({ sessionId: "abc123", goal: "extract the database schema decisions" })` — uses LLM to extract only relevant info

use this when a handoff prompt references a previous session ID and you need more detail than the prompt provides.

### search_sessions

search across all sessions by text query.

- `search_sessions({ query: "auth middleware" })` — find sessions mentioning auth middleware
- `search_sessions({ query: "flake.nix", cwd: "/path/to/project" })` — scope to a specific project
- `search_sessions({ query: "sops", limit: 5 })` — limit results

returns session IDs, metadata, and first-message previews. use `read_session` on a match to get the full conversation.

## context after handoff

you will NOT have access to the old session's messages directly. the handoff prompt is your primary context. use `read_session` with the referenced session ID if you need more detail.

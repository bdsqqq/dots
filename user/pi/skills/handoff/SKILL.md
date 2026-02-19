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
2. **be aware of your context usage.** if you've done a lot of tool calls and file reads, you're probably getting heavy.
3. **when context is getting heavy, hand off.** call the `handoff` tool with the next task as the goal. don't ask — just call it.
4. **front-load investigation.** read what you need early, make decisions, then execute. don't re-read files you've already seen.

## invoking handoff

you have a `handoff` tool. call it directly when:
- context is getting heavy (lots of tool calls, file reads, back-and-forth)
- you've completed a unit of work and the next task is clear
- you're about to hit diminishing returns in the current session

```
handoff({ goal: "implement the auth middleware we planned" })
```

the tool generates a handoff prompt (via extraction model) and stages `/handoff` in the editor. the user presses Enter to review the prompt, then confirms to switch sessions.

the user can also run `/handoff <goal>` manually — this generates a prompt and shows it for review before sending.

## what happens during handoff

1. conversation is serialized and sent to a dedicated model (haiku 4.5)
2. the model is forced to call a `create_handoff_context` tool that extracts structured output: `relevantInformation` (first-person context bullets) + `relevantFiles` (workspace-relative paths)
3. the final prompt is assembled in code: session link → @file references → context bullets → goal
4. a new session is created with `parentSession` linking to the old one
5. the prompt is sent as the first message — you start working immediately

## session tools

you have two tools for accessing previous sessions:

### read_session

read a previous session's conversation by ID. supports partial UUID matching. returns the full serialized conversation as markdown.

- `read_session({ sessionId: "abc123" })` — returns the conversation

use this when a handoff prompt references a previous session ID and you need more detail than the prompt provides.

### search_sessions

search across all sessions by text query.

- `search_sessions({ query: "auth middleware" })` — find sessions mentioning auth middleware
- `search_sessions({ query: "flake.nix", cwd: "/path/to/project" })` — scope to a specific project
- `search_sessions({ query: "sops", limit: 5 })` — limit results

returns session IDs, metadata, and first-message previews. use `read_session` on a match to get the full conversation.

## context after handoff

you will NOT have access to the old session's messages directly. the handoff prompt is your primary context. use `read_session` with the referenced session ID if you need more detail.

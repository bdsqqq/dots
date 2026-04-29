## handoff v2 spec

goal: make handoff a pi-native-ish “summary fork” instead of a bespoke prompt-staging system.

```text
handoff = pi compaction-style summary range
        + create child session with parentSession
        + seed child with a custom_message carrying summary/goal
        + append source-side custom link to child seed entry
```

## design choices

1. **summary range:** use pi compaction-style prepared range, not whole-branch extraction.
2. **child seed entry type:** use `custom_message`, because the handoff payload is agent-written first-person context, not a user-authored prompt.
3. **implementation:** extension-only for now; upstream transactional API later.
4. **link target:** source custom link targets the child seed `custom_message` entry.

## non-goals

- no core session schema changes.
- no path hints in metadata.
- no prompt/content duplication in metadata.
- no custom metadata required for vanilla pi to parse the session.
- no two-way source/child atomicity until pi provides a transaction-like API.
- no whole-branch handoff extraction in v2 target behavior.

## native primitives used

```text
SessionHeader.parentSession              child → source link
SessionManager.appendCustomEntry         source → child breadcrumb
custom_message entry                     child seed context, participates in LLM context
SessionManager.branch(sourceLeafId)      append breadcrumb at correct source leaf
ctx.newSession({ parentSession, setup }) native session creation/switch
prepareCompaction-style range            same range semantics as /compact
```

## data model

### source-side link entry

source session gets one custom entry:

```json
{
  "type": "custom",
  "customType": "bdsqqq/handoff",
  "id": "<pi-generated-entry-id>",
  "parentId": "<source-leaf-id>",
  "timestamp": "<iso timestamp>",
  "data": {
    "version": 1,
    "target": {
      "sessionId": "<child-session-id>",
      "entryId": "<child-seed-custom-message-entry-id>"
    }
  }
}
```

### invariants

- `data.version` is handoff extension metadata version.
- `target.sessionId` is canonical child session identity.
- `target.entryId` is the child `custom_message` entry that materializes the handoff payload.
- no `targetPathHint`.
- no `carryMode`; `customType` / event kind implies summary handoff.
- no verbatim prompt/content in metadata; destination session contains payload as normal context.
- source and child can be resolved by index, scan, or future graph backend.

## child session shape

child header:

```json
{
  "type": "session",
  "version": 3,
  "id": "<child-session-id>",
  "timestamp": "...",
  "cwd": "...",
  "parentSession": "<source-session-file>"
}
```

child seed entry:

```json
{
  "type": "custom_message",
  "id": "<child-seed-entry-id>",
  "parentId": null,
  "timestamp": "...",
  "customType": "bdsqqq/handoff",
  "content": "<first-person handoff summary/context>\n\n<customInstructions>",
  "display": true,
  "details": {
    "version": 1,
    "source": {
      "sessionId": "<source-session-id>",
      "entryId": "<source-leaf-id>"
    }
  }
}
```

notes:
- `content` participates in LLM context.
- `details` does not participate in LLM context.
- `details.source` is optional but useful for local rendering/debugging. if we want the absolute minimum identity surface, omit it and rely on `parentSession`.
- `display: true` makes the handoff context visible in the child transcript.

## source session shape

before:

```text
source session S1

entry:  0     1     2      3
      ┌─────┬─────┬─────┬──────┐
      │ hdr │ usr │ ass │ tool │
      └─────┴─────┴─────┴──────┘
                              ↑
                           leaf L
```

after handoff:

```text
source session S1

entry:  0     1     2      3      4
      ┌─────┬─────┬─────┬──────┬──────┐
      │ hdr │ usr │ ass │ tool │ link │
      └─────┴─────┴─────┴──────┴──────┘
                              │      │
                              │      └─ custom bdsqqq/handoff
                              │         target = { S2, seedEntry }
                              │
                           leaf L
```

child session:

```text
child session S2

header.parentSession = S1

entry:  0      1       2
      ┌─────┬────────┬─────┐
      │ hdr │ seed   │ ... │
      └─────┴────────┴─────┘
              ↑
              └─ custom_message:
                 first-person summary + goal
```

logical projection:

```text
S1 ─ usr ─ ass ─ tool ─ link
                          │
                          ▼
                         S2 ─ seed(custom_message) ─ ass ─ ...
```

## summary range semantics

handoff v2 should use the same range semantics as compaction:

```text
range = preparation.messagesToSummarize + preparation.turnPrefixMessages
```

not:

```text
range = whole active branch
```

expected behavior:

```text
/compact
  summarize selected older span
  keep recent messages literal
  store summary in same file

/handoff
  summarize selected older span
  materialize summary in child custom_message
  continue in new file linked by parentSession + source backlink
```

### how to obtain preparation

target implementation should reuse pi’s compaction preparation if available from exports:

```ts
import { prepareCompaction } from "@mariozechner/pi-coding-agent";

const pathEntries = ctx.sessionManager.getBranch();
const settings = ctx.settingsManager.getCompactionSettings(); // exact API availability to verify
const preparation = prepareCompaction(pathEntries, settings);
```

if `settingsManager` is not exposed on extension context, options:
1. import and read compaction settings via available pi settings APIs, if exported.
2. add a small upstream/extension API to expose `prepareCompaction` or `ctx.prepareCompaction()`.
3. temporary fallback: use current whole-branch extraction, but mark v2 blocked until native preparation is accessible.

preferred: do not reimplement cut-point logic in the extension.

## prompt / summary generation

summary model prompt should use the existing shared handoff/compaction prompt sections, but feed it the compaction-prepared serialized range:

```ts
const conversationText = serializeConversation(
  convertToLlm([
    ...preparation.messagesToSummarize,
    ...preparation.turnPrefixMessages,
  ]),
);
```

include:
- shared principles
- handoff intent
- handoff format/tool call extraction, or a new plain summary mode if we no longer need `relevantFiles`
- `summary goal:\n${customInstructions}`
- previous summary, if `preparation.previousSummary` exists

open question: keep structured extraction tool (`create_handoff_context`) or switch handoff v2 to plain summary generation like compaction?

recommendation:
- v2.0: keep structured extraction if we still want `relevantFiles`.
- v2.1: consider plain summary only, since child custom_message can include file sections like compaction.

## materialization

child `custom_message.content` should be generated summary/context plus the custom instructions appended verbatim after two line breaks.

```text
<generated first-person summary/context>

<customInstructions>
```

this mirrors the current materialization decision:
- summary model is informed by the goal.
- final child context also carries the goal programmatically.
- no metadata duplicates the goal.

## algorithm

### command path: `/handoff <customInstructions>`

1. validate `customInstructions.trim()`.
2. capture source identity:
   - `sourceFile = ctx.sessionManager.getSessionFile()`
   - `sourceHeader = ctx.sessionManager.getHeader()`
   - `sourceSessionId = sourceHeader.id`
   - `sourceBranch = ctx.sessionManager.getBranch()`
   - `sourceLeafId = sourceBranch.at(-1)?.id ?? null`
3. prepare compaction-style range:
   - `preparation = prepareCompaction(sourceBranch, compactionSettings)`
   - if no preparation, decide fallback:
     - either error: “nothing to handoff”
     - or summarize whole branch as compatibility fallback
   - recommendation: error for v2 native semantics; avoid silent behavior drift.
4. generate handoff summary from prepared range.
5. materialize handoff content:
   - `childContent = materializeGoal(summaryOrPrompt, customInstructions)`
6. create child session via `ctx.newSession({ parentSession: sourceFile, setup })`.
7. in `setup(childManager)`:
   - get child session id from `childManager.getHeader()?.id`.
   - append child seed `custom_message`:
     - `customType: "bdsqqq/handoff"`
     - `content: childContent`
     - `display: true`
     - optional `details.version = 1`
     - optional `details.source = { sessionId: sourceSessionId, entryId: sourceLeafId }`
   - capture returned `childSeedEntryId`.
8. after `ctx.newSession()` resolves:
   - reopen source with `SessionManager.open(sourceFile)`.
   - restore append position:
     - if `sourceLeafId`: `sourceManager.branch(sourceLeafId)`
     - else: `sourceManager.resetLeaf()`
   - append source backlink:

```ts
sourceManager.appendCustomEntry("bdsqqq/handoff", {
  version: 1,
  target: {
    sessionId: childSessionId,
    entryId: childSeedEntryId,
  },
});
```

9. child session is already active; editor/runtime are mounted to child.
10. notify:
   - success: `handoff created`
   - warning if backlink append failed.

## failure handling

```text
customInstructions blank
  show usage error, no changes

prepareCompaction unavailable / returns undefined
  preferred v2: error, no changes
  optional fallback: whole-branch summary only behind explicit compatibility flag

summary generation fails
  no child session, no source link

child setup fails
  ctx.newSession likely fails or returns cancelled; no source link

source link append fails after child created
  child remains valid via parentSession
  notify warning: "handoff created, but source backlink failed"
  future repair command can scan parentSession and recreate links
```

## atomicity

extension-only implementation is not fully atomic:

```text
create child + seed child  ✅
append source backlink     ✅ but after switch
```

crash between those steps leaves a child reachable from its `parentSession`, but source lacks direct child edge.

this is acceptable for v2 extension-only because:
- child remains valid vanilla pi session.
- source backlink can be repaired by scanning child sessions for `parentSession`.
- no custom core schema is required.

future pi-native API could provide:

```ts
ctx.newLinkedSession({
  parentSession,
  setupTarget(targetManager) {},
  setupSource(sourceManager, targetInfo) {},
});
```

or:

```ts
ctx.newSession({
  parentSession,
  setupTarget(targetManager) {},
  setupSource(sourceManager, targetManager) {},
});
```

## resolver

input:

```ts
type HandoffTarget = {
  sessionId: string;
  entryId: string;
};
```

default resolver:

1. search session index for `header.id === sessionId`.
2. open session file.
3. find entry by `entryId`.
4. verify `entry.type === "custom_message"` and `entry.customType === "bdsqqq/handoff"` when resolving handoff links.
5. return `{ sessionPath, entry }`.

future resolver:

```text
(sessionId, entryId) → local jsonl | synced index | graph backend | remote host
```

no metadata changes needed.

## rendering / ui

### source side

custom entry should render as a compact navigable backlink:

```text
↳ handoff → <child session name or id>
```

actions:
- open child session
- copy child session id
- inspect target entry

### child side

custom message should render as visible handoff context:

```text
handoff context
<summary/context>

<customInstructions>
```

existing provenance widget can still use `parentSession`:

```text
↳ handed off from: <source session name>
```

## compatibility

vanilla pi:
- parses source `custom` entry.
- ignores custom data unless extension loaded.
- child session is normal pi session with `parentSession`.
- child custom_message participates in context as extension-injected message.

extension absent:
- handoff child session still contains the visible context message.
- source-side custom entries are inert.
- cross-file backward lineage still works through `parentSession`.

extension upgraded:
- check `data.version`.
- unsupported version: preserve entry, do not mutate.

## migration from v1 handoffs

v1 handoffs:
- child has `parentSession`.
- source has no custom backlink.
- prompt was staged in editor, not pre-seeded as custom_message.
- handoff extraction used whole active branch.

repair command could scan sessions:

```text
for each session child:
  if child.header.parentSession exists:
    open parent
    if no bdsqqq/handoff custom entry targeting child.header.id:
      append repair link at parent best inferred leaf
```

hard part: exact `sourceLeafId` and child seed entry may be unknown.

repair policy:
- do not auto-repair silently.
- provide explicit `/handoff repair-links`.
- if exact source leaf cannot be inferred, skip or append with `data.repaired: true` only if user confirms.

## open implementation questions

1. **access to compaction preparation**
   - can extension import `prepareCompaction` and access compaction settings cleanly?
   - if not, ask upstream for `ctx.prepareCompaction()` or access to settings.

2. **append custom_message API**
   - verify whether `SessionManager` exposes `appendCustomMessage` or whether we need `appendEntry` / lower-level entry construction.
   - must avoid private `_appendEntry()` unless no public API exists.

3. **child seed entry parent**
   - likely `parentId: null` because child starts with the custom_message.
   - if header is not considered an entry in branch ancestry, first appended entry gets parent null.

4. **summary shape**
   - keep current tool extraction with relevant files, or switch to plain summary + file sections like compaction.
   - target long-term: same summary shape as compaction/tree.

## acceptance criteria

- `/handoff <customInstructions>` creates a child session with `parentSession`.
- handoff summary range is compaction-prepared, not whole-branch.
- child session contains a visible `custom_message` seed before user input.
- child seed content is generated summary/context plus `customInstructions` appended verbatim after two line breaks.
- source session gets `customType: "bdsqqq/handoff"` entry pointing to `{ sessionId, entryId }`.
- source custom entry stores ids only, no paths.
- no custom metadata enters llm context except the child `custom_message.content`, intentionally.
- vanilla pi can still open both sessions.
- source→child traversal works without scanning all sessions when extension is loaded.
- child→source traversal still works via `parentSession`.
- tests cover:
  - custom source link data shape
  - child `custom_message` seed data shape
  - source link targets the child seed entry id
  - blank instructions fail without creating sessions
  - compaction-prepared range is used
  - source link append failure warning
  - resolver follows source custom link to child custom_message
  - absent extension leaves normal child session usable.

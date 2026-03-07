# capability architecture inside pi

this note replaces the earlier capability docs.

## lede

pi already has an extension system, package system, lifecycle model, ui host api, and settings model. we should not build a second one.

our job is narrower:

- use pi extensions as the top-level runtime units
- use pi packages as the top-level distribution/install units
- build **package-local capability composition** inside `user/pi`
- degrade by omission when optional pieces are absent

if we keep that boundary, we get a solid internal architecture without competing with pi itself.

---

## what pi already owns

pi already provides the outer platform.

### resource loading and lifecycle

pi already owns:

- extension discovery and loading
- package installation and filtering
- reload behavior
- lifecycle events
- sdk resource loading through `ResourceLoader` / `DefaultResourceLoader`

that means we should not invent our own loader, manifest format, or top-level plugin lifecycle.

### extension runtime apis

pi already gives extensions the primitives to integrate behavior:

- `pi.on(...)`
- `pi.registerTool(...)`
- `pi.registerCommand(...)`
- `pi.registerShortcut(...)`
- `pi.registerFlag(...)`
- `pi.registerMessageRenderer(...)`
- `pi.registerProvider(...)`
- `pi.events` for inter-extension communication
- `ctx.ui.*` for dialogs, widgets, status, editor replacement, footer replacement, overlays

that means our architecture should be an adaptation layer over pi’s public api, not a substitute for it.

### package management and resource enablement

pi already owns:

- package install sources (`npm:`, `git:`, local paths)
- package filtering
- enable/disable of extensions, skills, prompts, and themes
- scope and dedup rules between global and project installs

that means `core/config` should not try to replace pi’s settings or package/resource enablement. it should only help our package define and validate **our own namespaced config**.

### package isolation

pi packages load with separate module roots. separate installs do not collide or share modules.

that means we cannot assume that a singleton exported from one installed package is a universal registry for every other pi package in the process.

this is a big constraint.

---

## the boundary

### pi is the outer plugin system

pi owns:

- discovery
- loading
- lifecycle
- settings
- package install/update/remove
- ui host primitives
- extension-to-extension event bus

### our capability system is internal composition

`user/pi` should own only:

- contracts for our domains
- package-local registries
- shared helpers and adapters
- graceful participation rules
- optional use of `pi.events` when extension boundaries require runtime coordination

this is the key sentence:

> our capability system is an internal composition layer for this pi package. it does not replace pi’s extension/package system.

---

## design principle

build optional capabilities, not mandatory stacks.

features should compose by presence. they should degrade by omission. if a consumer only loads one layer, that layer should still do useful work.

missing layers should:

- hide affordances
- return `null` / `[]` / no-op
- skip registration
- keep core feature behavior intact

missing layers should not:

- crash startup
- leave half-wired runtime state
- make unrelated features fail

---

## architecture layers

inside `user/pi`, separate four concerns.

```mermaid
flowchart tb
  contracts[contracts\ntypes + interfaces]
  registries[package-local registries\nregister + discover]
  runtime[runtime services\nresolve + cache + orchestrate]
  adapters[pi adapters\nevents / ui / tools / commands]

  contracts --> registries
  registries --> runtime
  registries --> adapters
```

### contracts

define what a capability is.

examples:

- mention source
- editor autocomplete contributor
- config schema

### registries

let parts of our package contribute capabilities without central switch statements.

these registries are **package-local**, not global pi infrastructure.

### runtime services

do the domain work.

examples:

- session parsing
- git commit indexing
- handoff prompt extraction
- context rendering

### adapters

connect our internal capabilities to pi’s public extension/runtime hooks.

examples:

- `pi.on("input")`
- `pi.on("context")`
- `ctx.ui.setEditorComponent(...)`
- `pi.registerTool(...)`
- `pi.registerCommand(...)`

---

## use events vs registries correctly

### use package-local registries for request/response composition

examples:

- mention resolution
- mention autocomplete
- editor autocomplete contributors
- config schema lookup

these want typed request/response contracts.

### use `pi.events` at extension boundaries

examples:

- one extension advertising that an optional host is present
- ui notifications across independent extensions
- soft coordination where shared module state is not reliable

`pi.events` is the safe bridge when runtime boundaries matter.

### do not use events for everything

event soup makes autocomplete and resolution logic mushy. keep typed contracts where we control both sides inside the package.

---

## what this means for the current packages

## `packages/core/mentions/`

`core/mentions` should become a capability framework for addressable references inside this package.

it should own:

- generic `@namespace/value` parsing
- mention contracts
- a package-local mention registry
- shared resolution/render helpers
- shared low-level indexing helpers like session parsing and git helpers

it should not own:

- top-level extension discovery
- package installation
- a universal pi-wide mention plugin system

### target contract sketch

```ts
interface MentionContext {
  cwd: string
  sessionsDir?: string
  config?: Record<string, unknown>
}

interface MentionSource {
  namespace: string
  isAvailable(ctx: MentionContext): boolean
  describe?(ctx: MentionContext): {
    description?: string
    priority?: number
  }
  getSuggestions(query: string, ctx: MentionContext): MentionCompletionItem[] | Promise<MentionCompletionItem[]>
  resolve(value: string, token: MentionToken, ctx: MentionContext): MentionResolved | null | Promise<MentionResolved | null>
  render?(resolved: MentionResolved, ctx: MentionContext): string
}
```

### key constraint

this registry is for `user/pi` internals. if independent pi packages ever need to contribute mention sources, that coordination should go through pi’s extension/runtime mechanisms, likely `pi.events`, not hidden assumptions about shared module singletons.

---

## `packages/extensions/mentions/`

this should be a pi adapter over the internal mention system.

it should:

- hook `input`
- parse tokens
- resolve through the package-local registry
- inject hidden context on `context`
- register the mention autocomplete contributor when the editor host is present
- clear adapter state on lifecycle transitions

it should be valid to run with:

- zero sources registered
- no custom editor installed
- only a subset of mention sources available

### degradation rule

if no source exists for a namespace, resolution should quietly miss. no crash, no startup failure.

---

## `packages/core/editor-capabilities/`

this package should own the editor-side host/contributor seam.

it should own:

- the autocomplete contributor contract
- the package-local contributor registry
- provider composition over pi's base editor autocomplete

it should not own:

- box chrome or editor ui rendering
- mention/session/handoff semantics
- any cross-package plugin assumptions beyond `user/pi`

this keeps `extensions/editor` generic while letting adapters like `extensions/mentions` contribute domain behavior.

---

## `packages/extensions/editor/`

this should be a custom editor host built on pi’s public editor replacement api.

it should continue to own:

- box chrome
- labels
- status row
- widgets
- spinner/activity presentation
- footer replacement
- working-directory / branch display

it should stop owning:

- domain-specific autocomplete logic for mentions or other features

### target role

editor becomes a **ui host** with package-local contributor interfaces.

```mermaid
flowchart lr
  base[base file autocomplete adapter] --> editor[editor host]
  mentions[mentions autocomplete contributor] --> editor
  future[other contributors] --> editor
```

### important boundary

this is not a competing extension system. pi already gives us `ctx.ui.setEditorComponent(...)`. we are just building a better internal editor architecture inside the editor extension.

---

## `packages/extensions/handoff/`

handoff should remain a normal pi extension that owns the handoff feature.

it should keep owning:

- compaction replacement
- prompt extraction
- prompt review flow
- session switch
- provenance presentation
- `/handoff`
- the `handoff` tool

it additionally contributes optional capabilities:

- the `handoff` mention source
- editor labels/widgets
- other ui affordances

### degradation rule

handoff must still work when:

- mention autocomplete is absent
- mention runtime injection is absent
- editor host extensions are absent

those absences remove affordances. they do not remove handoff itself.

---

## `packages/extensions/search-sessions/`

search-sessions should keep owning the search tool and related search rendering.

it now contributes:

- the `session` mention source built on shared session parsing/indexing

this means session semantics come from the session domain, not from a central hardcoded mention switchboard.

---

## `packages/core/config/`

`core/config` should stay a helper for our package’s namespaced config and grow into schema/gating support.

it should own:

- merged config loading for our namespaces
- validation hooks
- common `enabled` gating conventions
- optional schema registration for our package-local capabilities

it should not own:

- package install/discovery
- global pi resource enablement
- a second settings system alongside pi’s own

### target contract sketch

```ts
interface ConfigSchema<T> {
  namespace: string
  defaults: T
  validate?(input: unknown): T
  describe?: {
    title: string
    docs?: string
  }
}
```

---

## current capability inventory to preserve

the refactor should preserve current behavior while changing ownership boundaries.

### mentions currently support

- `@commit/<sha-prefix>`
- `@session/<session-id-prefix>`
- `@handoff/<session-id-prefix>`
- mention parsing in submitted text
- mention prefix detection for autocomplete
- commit suggestions from git history
- session/handoff suggestions from session index
- graceful hiding of commit completions outside git repos
- hidden context injection through the `context` event
- session parsing, branch enumeration, and mentionable session summarization

### editor currently supports

- custom box-drawn editor
- top/bottom border labels with left/right alignment
- cached border rendering
- status rows below editor
- activity spinner and tool tracking
- cwd + git branch display
- model / thinking / token / cost stats
- git diff summary after agent completion
- extension label updates over `pi.events`

### handoff currently supports

- compaction replacement
- threshold-based automatic handoff prompt generation
- manual `/handoff <goal>` flow
- agent-callable `handoff` tool
- handoff prompt editing before switch
- session forking via `parentSession`
- provenance display for handed-off sessions
- editor/status notifications when handoff is ready

### search-sessions currently supports

- session-file discovery
- ripgrep prefiltering
- branch enumeration and filtering
- workspace scoping
- date filtering
- file filtering
- text rendering and boxed rendering

### config currently supports

- defaults → global → project merge order
- opt-in project-local config
- caching
- deep merge for plain objects
- arrays replace, not merge
- graceful fallback on malformed or missing files

all of that is in scope to preserve.

---

## concrete refactor direction

## phase 1 — extract contracts

add package-local contracts and registries without changing behavior yet.

- mention contracts + registry
- editor contributor contracts
- config schema contracts

compatibility shims are fine here.

## phase 2 — move editor to contributor hosting

remove direct mention wiring from editor.

editor should host autocomplete contributors, not import mention behavior directly.

hotspot 1 now does this with `core/editor-capabilities`: editor recomposes its base provider through registered contributors, and `extensions/mentions` registers the mention adapter.

## phase 3 — convert mentions extension into a pure adapter

keep pi lifecycle hooks in the extension.
move mention family ownership to registered sources.

## phase 4 — let feature domains provide optional capabilities

this is now partially done:

- handoff provides the `handoff` mention source
- search-sessions provides the `session` mention source
- commit remains built in to `core/mentions` for now

## phase 5 — extend config for schema-backed gating

let features say "participate" or "do not participate" cleanly through config, without creating a second settings system.

---

## verification matrix

every phase should preserve graceful partial installs.

| loaded pieces | expected behavior |
| --- | --- |
| editor only | editor works |
| mentions adapter only | mention resolution works for any registered sources, no autocomplete |
| editor + mentions autocomplete contributor | mention autocomplete works |
| handoff only | handoff works |
| handoff + mentions adapter | handoff mentions can resolve if source is registered |
| handoff + editor only | handoff works, but no mention resolution unless adapter exists |
| search-sessions only | tool works |
| search-sessions + mentions adapter | `@session/...` can resolve if source is registered |

if any of these combinations crash, we are building too much coupling.

---

## anti-goals

we should explicitly avoid these:

- a second extension loader
- a second package manifest for top-level resources
- repo-local resource enable/disable that competes with pi package filtering
- assumptions that separate installed pi packages share singletons
- replacing pi lifecycle with our own framework runtime

if a design drifts into one of those, back up.

---

## short version

pi is the platform. `user/pi` is one package on that platform.

inside `user/pi`, we should:

- define typed contracts
- register optional capabilities locally
- adapt them onto pi’s public extension hooks
- use `pi.events` only where extension boundaries require a bridge
- preserve graceful degradation when optional layers are absent

that is the architecture to keep coming back to.

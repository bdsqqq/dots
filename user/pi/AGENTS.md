# pi submodule conventions

scope: `user/pi`

## commits

- include the submodule in commit scopes.
- format: `<type>(pi/<scope>): <summary>`
- examples:
  - `feat(pi/code-review): add schema-based startup gating`
  - `test(pi/e2e): add config-gating smoke coverage`
  - `docs(pi/skills): add config-gating hotspot workflow`

## history

- preserve true history.
- prefer small in-tree commits over squashy cleanup.
- stage only files for the current slice.
- ignore unrelated `*.sync-conflict-*` junk unless the task is explicitly about them.

## tests

- **everything inline** — use `if (import.meta.vitest) { ... }` blocks at the bottom of source files. no `__tests__/` directories.
- **test outcomes, not implementation** — "prompt appears in editor" not "sendUserMessage was called".
- **only mock boundaries** — file system, network, LLM. never mock the system under test.
- **thin wrappers don't need execution tests** — sub-agents that just call `piSpawn` have no meaningful unit tests. their value is prompt quality, which is an eval, not a unit test.
- **TUI components**: mock theme to strip ANSI (`fg: (_, text) => text`), assert on `render(width)` output.
- **export internals for testing**, but don't advertise in package.json exports.

**what to test inline:**

- string transformations
- type guards / validators
- parsing / data extraction
- pure utility functions
- extension registration (with minimal tracking mocks)

**what NOT to test:**

- "was piSpawn called with correct args" — that's testing piSpawn's contract
- string interpolation / template assembly — trivial
- config pass-through — just data

verify with:

- `bun x tsc -p tsconfig.build.json --noEmit`
- `bun run test`

## style

- smallest viable diff.
- copy proven patterns from nearby adopters before inventing a new shape.
- prefer sdk/session-level probes when startup registration needs stronger proof than local spies.

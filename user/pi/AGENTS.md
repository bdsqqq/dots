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

- prefer inline `import.meta.vitest` coverage in `index.ts` when the logic is local and pure.
- keep separate test files for scenario coverage, sdk/session smoke tests, tmux/tui flows, network/auth cases, and fixture-driven contracts.
- for config-gating and similar startup slices, verify with:
  - `bun x tsc -p tsconfig.build.json --noEmit`
  - targeted `bun x vitest run ...`
  - `bun run test`

## style

- smallest viable diff.
- copy proven patterns from nearby adopters before inventing a new shape.
- prefer sdk/session-level probes when startup registration needs stronger proof than local spies.

# full migration process: start to finish

## phase 0: preparation

**0.1 switch from bun test to vitest**

```bash
bun add -D vitest @vitest/coverage-v8
```

**0.2 create vitest config**

```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    includeSource: ["packages/**/*.ts"],
  },
  define: {
    "import.meta.vitest": "undefined",
  },
});
```

**0.3 add vitest types**

```json
// tsconfig.json
{
  "compilerOptions": {
    "types": ["vitest/importMeta"]
  }
}
```

---

## phase 1: create package structure

**1.1 create packages directory**

```
packages/
├── core/           # horizontal: shared utilities
│   ├── box-chrome/
│   ├── box-format/
│   ├── show/
│   ├── output-buffer/
│   ├── file-tracker/
│   ├── mutex/
│   ├── permissions/
│   ├── interpolate/
│   ├── tool-cost/
│   ├── html-to-md/
│   ├── tui/
│   ├── agents-md/
│   ├── github-api/     # lib/github.ts
│   ├── pi-spawn/
│   └── sub-agent-render/
├── tools/          # vertical: actual tools
│   ├── read/
│   ├── ls/
│   ├── grep/
│   ├── glob/
│   ├── bash/
│   ├── edit-file/
│   ├── create-file/
│   ├── undo-edit/
│   ├── format-file/
│   ├── code-review/
│   ├── finder/
│   ├── librarian/
│   ├── look-at/
│   ├── oracle/
│   ├── task/
│   ├── read-session/
│   ├── read-web-page/
│   ├── web-search/
│   ├── skill/
│   ├── search-sessions/
│   └── github/        # 7 github tools
└── extensions/    # root extensions
    ├── handoff/
    ├── session-name/
    ├── system-prompt/
    └── tool-harness/
```

---

## phase 2: migrate a leaf module (no internal deps)

**example: `output-buffer`**

**2.1 create package directory**

```bash
mkdir -p packages/core/output-buffer
```

**2.2 move implementation**

```typescript
// packages/core/output-buffer/index.ts
// (content from tools/lib/output-buffer.ts)

export const HEAD_LINES = 50;
export const TAIL_LINES = 50;
// ... rest of implementation

// inline tests
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe("output-buffer", () => {
    it("truncates output correctly", () => {
      // (tests from output-buffer.test.ts)
    });
  });
}
```

**2.3 create package.json**

```json
{
  "name": "@pi/output-buffer",
  "version": "0.0.0",
  "type": "module",
  "main": "index.ts",
  "types": "index.ts",
  "exports": {
    ".": "./index.ts"
  },
  "devDependencies": {
    "vitest": "^3.0.0"
  }
}
```

**2.4 update root workspace**

```json
// package.json
{
  "workspaces": {
    "packages": [
      "packages/core/*",
      "packages/tools/*",
      "packages/extensions/*",
      "extensions/mermaid",
      "extensions/command-palette",
      "extensions/editor"
    ],
    "catalog": {
      "@mariozechner/pi-coding-agent": "^0.55.4",
      "@mariozechner/pi-tui": "^0.55.4",
      "@sinclair/typebox": "^0.34.0"
    }
  }
}
```

**2.5 install and verify**

```bash
bun install
bun test packages/core/output-buffer
```

**2.6 delete old files**

```bash
rm tools/lib/output-buffer.ts tools/lib/output-buffer.test.ts
```

---

## phase 3: migrate a module with internal deps

**example: `sub-agent-render` (depends on `pi-spawn`, `tool-cost`)**

**3.1 wait for dependencies**

- `pi-spawn` must be migrated first
- `tool-cost` must be migrated first

**3.2 create package.json with deps**

```json
{
  "name": "@pi/sub-agent-render",
  "version": "0.0.0",
  "type": "module",
  "main": "index.ts",
  "types": "index.ts",
  "exports": {
    ".": "./index.ts"
  },
  "dependencies": {
    "@pi/pi-spawn": "workspace:*",
    "@pi/tool-cost": "workspace:*"
  },
  "devDependencies": {
    "vitest": "^3.0.0"
  }
}
```

**3.3 update imports**

```typescript
// before
import { spawnPi } from "./lib/pi-spawn";
import { formatCost } from "./lib/tool-cost";

// after
import { spawnPi } from "@pi/pi-spawn";
import { formatCost } from "@pi/tool-cost";
```

---

## phase 4: migrate a tool

**example: `bash` (depends on `read`, `mutex`, `output-buffer`, `permissions`, `tui`)**

**4.1 ensure all dependencies migrated**

- `@pi/output-buffer` ✓
- `@pi/mutex` ✓
- `@pi/permissions` ✓
- `@pi/tui` ✓
- `@pi/read` ← also a tool, migrate in order

**4.2 create package.json**

```json
{
  "name": "@pi/bash",
  "version": "0.0.0",
  "type": "module",
  "main": "index.ts",
  "types": "index.ts",
  "exports": {
    ".": "./index.ts"
  },
  "dependencies": {
    "@pi/output-buffer": "workspace:*",
    "@pi/mutex": "workspace:*",
    "@pi/permissions": "workspace:*",
    "@pi/tui": "workspace:*",
    "@pi/read": "workspace:*",
    "@sinclair/typebox": "catalog:"
  },
  "devDependencies": {
    "@mariozechner/pi-coding-agent": "catalog:",
    "vitest": "^3.0.0"
  }
}
```

---

## phase 5: create aggregate packages

**5.1 core utilities index**

```typescript
// packages/core/index.ts
export * from "@pi/output-buffer";
export * from "@pi/mutex";
export * from "@pi/file-tracker";
// ... etc
```

```json
// packages/core/package.json
{
  "name": "@pi/core",
  "dependencies": {
    "@pi/output-buffer": "workspace:*",
    "@pi/mutex": "workspace:*"
    // ... etc
  }
}
```

**5.2 tools index**

```typescript
// packages/tools/index.ts
export { createReadTool } from "@pi/read";
export { createBashTool } from "@pi/bash";
// ... etc

// pi extension entrypoint
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  pi.registerTool(createReadTool());
  pi.registerTool(createBashTool());
  // ... etc
}
```

---

## phase 6: clean up old structure

**6.1 delete old tools directory**

```bash
rm -rf extensions/tools/lib
rm -rf extensions/tools/*.ts extensions/tools/*.test.ts
```

**6.2 update extensions/tools/package.json to reference new packages**

```json
{
  "name": "pi-tools",
  "dependencies": {
    "@pi/core": "workspace:*",
    "@pi/bash": "workspace:*",
    "@pi/read": "workspace:*"
    // ... etc
  },
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

---

## migration status marker — 2026-03-06

hotspot 1/3 is done for the current inline-test pass.

moved inline so far:
- `packages/extensions/mentions/index.ts`
- `packages/extensions/search-sessions/index.ts`
- `packages/extensions/handoff/index.ts`
- `packages/extensions/bash/index.ts`
- `packages/extensions/editor/index.ts` — only `formatModelDisplay(provider, modelId)`
- `packages/core/github-api/index.ts` — pure helper coverage (`parseRepoUrl`, `repoSlug`, `decodeBase64Content`, `addLineNumbers`, `truncate`)

intentional holdouts:
- `packages/extensions/editor/editor.test.ts` — tmux e2e only
- `packages/extensions/github/github.test.ts` — real `gh api` + `pi` integration only
- `packages/extensions/e2e/e2e.test.ts`
- `packages/extensions/e2e/e2e-contract.test.ts`

why this boundary:
- inline tests are for local, pure logic that benefits from living beside the implementation.
- scenario tests stay separate when they need tmux, network auth, spawned `pi`, or fixture-driven contracts.
- `packages/core/*` owns helper coverage when the logic lives there; don't keep extension-local tests for core helpers.

verification used for each completed unit:
- `bun x tsc -p tsconfig.build.json --noEmit`
- targeted `bun x vitest run ...`
- `bun run test`

history markers from this pass:
- `257eb38` refactor(mentions): move session sources to owning extensions
- `442cbce` test(mentions): inline adapter coverage
- `a233e95` test(search-sessions): inline adapter coverage
- `4757323` test(handoff): inline adapter coverage
- `51e24bb` test(bash): inline output coverage
- `65b1210` test(editor): inline model display coverage
- `abcab17` test(github): inline helper coverage

next agents: preserve true history. commit each finished unit. if using `Task`, tell the child to commit in-tree.

## phase 7: verification

**7.1 typecheck**

```bash
bun run typecheck
```

**7.2 run all tests**

```bash
bun test
```

**7.3 verify imports resolve**

```bash
bun run check
```

---

## migration order

```
leaves (no internal deps):
├── box-chrome, show, output-buffer, file-tracker, mutex
├── permissions, interpolate, tool-cost, html-to-md, tui
├── agents-md, github-api
│
mid (depends on leaves):
├── box-format (→ box-chrome, show)
├── show-renderer (→ show)
├── pi-spawn (→ interpolate)
├── sub-agent-render (→ pi-spawn, tool-cost)
│
core fs tools:
├── read (→ output-buffer)
├── ls (→ read)
├── grep (→ output-buffer)
├── glob (→ output-buffer)
├── mutex, file-tracker utilities
├── edit-file, create-file, undo-edit, format-file (→ read, mutex, file-tracker)
├── bash (→ read, mutex, output-buffer, permissions, tui)
│
sub-agent tools (→ pi-spawn, sub-agent-render):
├── code-review, finder, librarian, look-at, oracle, task
├── read-session (→ pi-spawn, output-buffer)
├── read-web-page (→ pi-spawn, output-buffer, html-to-md, box-format)
│
integration tools:
├── github (→ github-api)
├── web-search (→ tool-cost)
│
misc:
├── skill, search-sessions
│
extensions:
├── handoff (→ pi-spawn)
├── session-name (standalone)
├── system-prompt (→ interpolate, pi-spawn)
├── tool-harness (standalone)
```

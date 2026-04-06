# Extension Testing Strategy

**TL;DR:** Use pi's SDK test utilities instead of homemade mocks. Test observable outcomes, not API traces. Ditch tmux for everything except true user interaction flows.

## Problem

We were "testing our own mocks." When pi 0.65.0 changed how runtimes work (creating new runtime per session), our tests passed because they only verified our mock was called, not that the extension worked with pi's actual behavior.

```ts
// Bad: testing our mock
const pi = { sendUserMessage: (m) => sentMessages.push(m) };
// ... extension calls pi.sendUserMessage()
expect(sentMessages).toContain(prompt); // ✅ passes, but broken in real pi

// Good: testing actual behavior outcomes
ctx.ui.setEditorText(prompt);
expect(ctx.ui.setEditorText).toHaveBeenCalledWith(prompt);
```

## Three-Layer Approach

### Layer 1: In-Source Pure Function Tests (`import.meta.vitest`)

For pure, stateless functions. Collocated with code for fast feedback.

```ts
// packages/extensions/handoff/index.ts

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest;

  describe("parsePromptSections", () => {
    it("extracts named sections from prompt text", () => {
      const result = parsePromptSections("# foo\nbar content\n# baz\nqux content");
      expect(result).toEqual({ "# foo": "bar content", baz: "qux content" });
    });
  });
}
```

**What goes here:**
- String transformations
- Type guards / validators
- Data extraction functions
- Pure utility functions

**What doesn't:**
- Event handlers
- Tool execution
- UI rendering
- Anything with state or side effects

### Layer 2: SDK-Backed Integration Tests (`__tests__/*.test.ts`)

For extension lifecycle, event handlers, tool execution. Uses pi's real API.

```ts
// packages/extensions/handoff/__tests__/handoff.test.ts

import { describe, it, expect, vi } from "vitest";
import handoffExtension, { createHandoffExtension, DEFAULT_DEPS } from "../index";

describe("handoff extension (SDK integration)", () => {
  it("registers handlers and commands when enabled", () => {
    const mockConfig = vi.fn(() => ({ enabled: true, config: CONFIG_DEFAULTS }));
    const ext = createHandoffExtension({
      ...DEFAULT_DEPS,
      getEnabledExtensionConfig: mockConfig as any,
      resolvePrompt: () => "",
      registerMentionSource: () => {},
    });

    const calls: { type: string; name?: string }[] = [];
    const mockPi = {
      registerTool: (tool: { name: string }) => calls.push({ type: "tool", name: tool.name }),
      registerCommand: (name: string) => calls.push({ type: "command", name }),
      on: (event: string) => calls.push({ type: "handler", name: event }),
      events: { emit: () => {} },
    } as any;

    ext(mockPi);

    expect(calls.filter(c => c.type === "handler").map(c => c.name).sort()).toEqual([
      "agent_end",
      "session_before_compact",
      "session_start",
      "session_start",
    ]);
  });
});
```

**Key principles:**
- Assert on **registrations** and **observable outcomes**, not internal state
- Only mock external boundaries: file system, LLM calls, network
- Use `it.todo()` to document tests that need pi SDK understanding

### Layer 3: Headless TUI Rendering Tests

For UI components. No tmux needed — instantiate components directly and assert on `render()` output.

```ts
// packages/extensions/handoff/__tests__/provenance-widget.test.ts

describe("provenance widget (headless TUI)", () => {
  it("renders provenance line with arrow prefix", () => {
    const { ui, widgets } = createMockUIContext();
    const ctx = createMockContext(ui);

    showProvenance(ctx, "/sessions/parent.jsonl");

    const widget = widgets.get("handoff-provenance");
    const lines = widget!.render(80);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("↳");
    expect(lines[0]).toContain("handed off");
  });
});
```

**Key insight:** Mock the theme to strip ANSI codes:

```ts
const mockTheme = {
  fg: (_color: string, text: string) => text, // strip colors
  bg: (_color: string, text: string) => text,
};
```

## Directory Structure

```
packages/extensions/handoff/
├── index.ts                    # Pure function tests via import.meta.vitest
├── handoff-mention-source.ts   # Pure function tests via import.meta.vitest
└── __tests__/
    ├── handoff.test.ts         # SDK-backed integration tests
    └── provenance-widget.test.ts  # Headless TUI rendering tests
```

## Migration Phases

### Phase 1: Structure & Pure Functions (S, <1h per extension)

1. Identify pure functions in the extension
2. Add `if (import.meta.vitest) { ... }` block at end of file
3. Write tests for pure functions
4. Remove any file system dependencies from pure function tests

### Phase 2: Extract Integration Tests (M, 1-3h per extension)

1. Create `__tests__/` directory
2. Move extension registration tests to `__tests__/{name}.test.ts`
3. Replace homemade mock harness with minimal tracking mocks
4. Add `it.todo()` for tests that need pi SDK

### Phase 3: Headless TUI Tests (M, 1-3h per extension)

1. Identify UI components (widgets, overlays)
2. Create `__tests__/ui.test.ts` or `{component}-widget.test.ts`
3. Mock theme to strip ANSI codes
4. Assert on `render(width)` output

### Phase 4: Full SDK Integration (L, 3-6h per extension)

1. Use `createAgentSession()` + `SessionManager.inMemory()`
2. Load extension into real session
3. Trigger commands/events via SDK
4. Assert on session state, editor text, etc.

## Migration Priority

| Priority | Extensions | Reason |
|----------|------------|--------|
| **High** | `handoff`, `editor`, `read-session` | Complex lifecycle, side-effects, recent bugs |
| **Medium** | `read`, `librarian`, `oracle` | Tool execution, config gating |
| **Low** | `mentions`, `skill`, `session-name` | Simple, mostly pure |

## When to Keep tmux

**Keep tmux for:**
- Multi-pane workflows
- Keyboard input sequences spanning UI state
- Clipboard integration testing
- Terminal image rendering verification

**Ditch tmux for:**
- Event handler behavior
- Tool execution
- TUI component output (use headless rendering)
- Session lifecycle

## Export Strategy

Export internals for testing, but don't expose in package.json:

```ts
// index.ts
export default handoffExtension;

// Export for testing
export {
  parsePromptSections,
  extractToolCallArgs,
  assembleHandoffPrompt,
  // ... other internals
};

// Note: These exports are available for tests but not advertised
// in package.json "exports" field
```

## Principles Summary

1. **Test outcomes, not implementation** — "prompt appears in editor" not "sendUserMessage was called"

2. **Use real components where feasible** — pi's in-memory SessionManager, real extension API

3. **Only mock boundaries** — file system, network, LLM — not the system under test

4. **Contract tests for external APIs** — if pi's API changes, tests that verify assumptions against actual runtime would fail

5. **Document with `it.todo()`** — capture tests that need deeper SDK understanding

## Reference

- Oracle consultation on testing strategy (2026-04-06)
- pi CHANGELOG 0.65.0 — runtime architecture changes
- handoff extension refactor — reference implementation

import type { AutocompleteProvider } from "@mariozechner/pi-tui";
import { describe, expect, it } from "vitest";
import {
  composeEditorAutocompleteProvider,
  registerEditorAutocompleteContributor,
} from "./index";

function createBaseProvider(log: string[]): AutocompleteProvider {
  return {
    async getSuggestions(lines, cursorLine, cursorCol) {
      log.push(`base:get:${lines[cursorLine] ?? ""}:${cursorCol}`);
      return {
        items: [{ value: "@file/src/index.ts", label: "@file/src/index.ts" }],
        prefix: "@f",
      };
    },
    applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => {
      log.push(`base:apply:${item.value}:${prefix}`);
      return {
        lines,
        cursorLine,
        cursorCol,
      };
    },
  };
}

describe("editor autocomplete capabilities", () => {
  it("lets contributors decorate the base provider and keep fallback behavior", async () => {
    const log: string[] = [];
    const unregister = registerEditorAutocompleteContributor({
      id: "mentions",
      enhance(provider, context) {
        log.push(`enhance:${context.cwd}`);
        return {
          async getSuggestions(lines, cursorLine, cursorCol, options) {
            const line = lines[cursorLine] ?? "";
            if (line.startsWith("@commit/")) {
              log.push("mentions:get");
              return {
                items: [{ value: "@commit/abc123", label: "@commit/abc123" }],
                prefix: "@commit/",
              };
            }
            return provider.getSuggestions(lines, cursorLine, cursorCol, options);
          },
          applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
            if (item.value.startsWith("@commit/")) {
              log.push(`mentions:apply:${prefix}`);
              return {
                lines,
                cursorLine,
                cursorCol,
              };
            }
            return provider.applyCompletion(
              lines,
              cursorLine,
              cursorCol,
              item,
              prefix,
            );
          },
        };
      },
    });

    try {
      const provider = composeEditorAutocompleteProvider(
        createBaseProvider(log),
        {
          cwd: "/repo/app",
        },
      );

      await expect(
        provider.getSuggestions(["@commit/"], 0, 8, { signal: new AbortController().signal }),
      ).resolves.toEqual({
        items: [{ value: "@commit/abc123", label: "@commit/abc123" }],
        prefix: "@commit/",
      });

      await expect(
        provider.getSuggestions(["@f"], 0, 2, { signal: new AbortController().signal }),
      ).resolves.toEqual({
        items: [{ value: "@file/src/index.ts", label: "@file/src/index.ts" }],
        prefix: "@f",
      });

      provider.applyCompletion(
        ["@f"],
        0,
        2,
        { value: "@file/src/index.ts", label: "@file/src/index.ts" },
        "@f",
      );

      expect(log).toEqual([
        "enhance:/repo/app",
        "mentions:get",
        "base:get:@f:2",
        "base:apply:@file/src/index.ts:@f",
      ]);
    } finally {
      unregister();
    }
  });

  it("applies higher priority contributors last so they become the outer host layer", async () => {
    const order: string[] = [];
    const unregisterInner = registerEditorAutocompleteContributor({
      id: "inner",
      priority: 0,
      enhance(provider) {
        order.push("enhance:inner");
        return {
          async getSuggestions(lines, cursorLine, cursorCol, options) {
            order.push("get:inner");
            return provider.getSuggestions(lines, cursorLine, cursorCol, options);
          },
          applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
            return provider.applyCompletion(
              lines,
              cursorLine,
              cursorCol,
              item,
              prefix,
            );
          },
        };
      },
    });
    const unregisterOuter = registerEditorAutocompleteContributor({
      id: "outer",
      priority: 10,
      enhance(provider) {
        order.push("enhance:outer");
        return {
          async getSuggestions(lines, cursorLine, cursorCol, options) {
            order.push("get:outer");
            return provider.getSuggestions(lines, cursorLine, cursorCol, options);
          },
          applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
            return provider.applyCompletion(
              lines,
              cursorLine,
              cursorCol,
              item,
              prefix,
            );
          },
        };
      },
    });

    try {
      const provider = composeEditorAutocompleteProvider(
        createBaseProvider(order),
        {
          cwd: "/repo/app",
        },
      );
      await provider.getSuggestions(["@f"], 0, 2, {
        signal: new AbortController().signal,
      });

      expect(order).toEqual([
        "enhance:inner",
        "enhance:outer",
        "get:outer",
        "get:inner",
        "base:get:@f:2",
      ]);
    } finally {
      unregisterOuter();
      unregisterInner();
    }
  });
});

import { defineConfig } from "vitest/config";
import { join } from "node:path";
import { tmpdir } from "node:os";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // First use may compile an on-demand language grammar.
    testTimeout: 60_000,
    // Keep on-demand grammars out of the repo; reuse across test runs in this env.
    env: {
      CALLDIFF_GRAMMAR_CACHE: join(tmpdir(), "calldiff-grammar-cache"),
    },
  },
});

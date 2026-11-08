import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [],
    includeSource: [
      "packages/core/box-format/rendering-assertions.ts",
      "packages/core/box-format/rendering-markdown.ts",
    ],
  },
});

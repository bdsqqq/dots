import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [],
    includeSource: [
      "scripts/rendering-assertions.ts",
      "scripts/rendering-markdown.ts",
    ],
  },
});

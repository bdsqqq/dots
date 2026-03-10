import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    includeSource: ["packages/**/*.ts"],
  },
  define: {
    "import.meta.vitest": "undefined",
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    includeSource: ["packages/**/*.ts"],
    exclude: ["node_modules/**", "**/*.sync-conflict-*.ts"],
  },
  define: {
    "import.meta.vitest": "undefined",
  },
});

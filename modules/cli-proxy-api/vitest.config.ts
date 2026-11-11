import { defineConfig } from "../pi/node_modules/vitest/dist/config.js";

export default defineConfig({
  test: { include: [], includeSource: ["*.ts"], testTimeout: 10_000 },
});

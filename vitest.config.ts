import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    // The compatibility tests shell out to the age CLI; keep runner CPU use modest.
    maxWorkers: 2,
    testTimeout: 30_000,
  },
});

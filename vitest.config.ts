// vitest.config.ts — test runner configuration for the Hashline SDK.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globals: false,
  },
});

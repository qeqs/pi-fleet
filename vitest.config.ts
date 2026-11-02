import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30000, // a busy CI runner has taken over 5 seconds for a few git commands
  },
});

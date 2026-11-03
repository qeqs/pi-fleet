import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30000, // a busy CI runner has taken over 5 seconds for a few git commands
    hookTimeout: 30000, // and a loaded machine over 10 for a hook that sets up a git repository
  },
});

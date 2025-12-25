import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Increase timeout for worker startup
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/integration/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    globals: true,
    environment: 'node',
    // Integration tests run sequentially to avoid port conflicts
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});

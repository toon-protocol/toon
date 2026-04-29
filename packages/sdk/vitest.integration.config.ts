import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'src/__integration__/**/*.test.ts',
      'tests/integration/**/*.test.ts',
    ],
    testTimeout: 60000,
  },
});

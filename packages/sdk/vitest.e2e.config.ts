import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@crosstown/core/toon': resolve(__dirname, '../core/src/toon/index.ts'),
      '@crosstown/core/nip34': resolve(__dirname, '../core/src/nip34/index.ts'),
      '@crosstown/core': resolve(__dirname, '../core/src/index.ts'),
      '@crosstown/relay': resolve(__dirname, '../relay/src/index.ts'),
      '@crosstown/sdk': resolve(__dirname, './src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/e2e/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 120000,
  },
});

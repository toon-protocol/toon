import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@toon-protocol/core/toon': resolve(__dirname, 'packages/core/src/toon/index.ts'),
      '@toon-protocol/core/nip34': resolve(__dirname, 'packages/core/src/nip34/index.ts'),
      '@toon-protocol/core': resolve(__dirname, 'packages/core/src/index.ts'),
      '@toon-protocol/sdk': resolve(__dirname, 'packages/sdk/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    // Unit tests must be hermetic: disable the bundled genesis peer seed
    // (packages/core/src/discovery/genesis-peers.json) so zero-known-peer
    // fixtures stay zero-peer regardless of live seed content. See toon#79.
    //
    // This MUST stay in sync with packages/sdk/vitest.config.ts. It was
    // missing here while the sdk config had it, so the root run bootstrapped
    // nodes against the live devnet apex in the seed; BootstrapService then
    // announced its own kind:10032 as a paid ILP PREPARE, adding an extra
    // sendPacket to fixtures that assert on exactly one published event and
    // adding intermediary hops to route-aware fee maths (toon#144).
    env: {
      TOON_GENESIS_PEERS: '[]',
    },
    testTimeout: 120_000,
    pool: 'forks',
    poolOptions: {
      forks: { minForks: 1, maxForks: 4 },
    },
    // Canonical test count: `pnpm test` at the repo root is the single source
    // of truth for total test count. All workspace members with tests must be
    // listed here so counts are consistent across pipeline steps.
    include: ['packages/*/src/**/*.test.ts', '.sandcastle/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/__integration__/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/*.test.ts',
        '**/__integration__/**',
        '**/index.ts',
      ],
    },
  },
});

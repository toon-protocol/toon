import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/__integration__/**',
      // ATDD story tracker: exclude test files whose source modules do not yet exist.
      // Re-include each file as its corresponding story is implemented:
      //   handler-registry.test.ts        -> Story 1.2 (done)
      //   handler-context.test.ts         -> Story 1.3 (done)
      //   verification-pipeline.test.ts   -> Story 1.4 (done)
      //   pricing-validator.test.ts       -> Story 1.5 (done)
      //   payment-handler-bridge.test.ts  -> Story 1.6 (done)
      //   create-node.test.ts             -> Story 1.7 (done)
      //   index.test.ts                   -> Story 1.7 (done)
      //   connector-api.test.ts           -> Story 1.8 (done)
      //   dev-mode.test.ts                -> Story 1.10
      'src/dev-mode.test.ts',
    ],
  },
});

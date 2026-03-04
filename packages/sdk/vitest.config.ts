import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/__integration__/**',
      // ATDD Red Phase: exclude test files whose source modules do not yet exist.
      // Re-include each file as its corresponding story is implemented:
      //   handler-registry.test.ts  -> Story 1.2
      //   handler-context.test.ts   -> Story 1.3
      //   verification-pipeline.test.ts -> Story 1.4
      //   pricing-validator.test.ts -> Story 1.5
      //   payment-handler-bridge.test.ts -> Story 1.6
      //   dev-mode.test.ts          -> Story 1.10
      'src/handler-registry.test.ts',
      'src/handler-context.test.ts',
      'src/verification-pipeline.test.ts',
      'src/pricing-validator.test.ts',
      'src/payment-handler-bridge.test.ts',
      'src/dev-mode.test.ts',
    ],
  },
});

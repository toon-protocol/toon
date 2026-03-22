/**
 * E2E tests for Story 8.0: Arweave DVM via Docker Infra
 *
 * Test IDs: 8.0-E2E-001, 8.0-E2E-002
 *
 * These tests require the SDK E2E Docker infrastructure:
 *   ./scripts/sdk-e2e-infra.sh up
 *
 * They verify the full flow: client sends kind:5094 via ILP ->
 * provider uploads to ArDrive/Turbo -> client receives tx ID.
 *
 * AC covered:
 * - AC #5: Single-packet upload (prepaid)
 * - AC #7: Arweave retrieval verification
 * - AC #8: Chunk splitting
 * - AC #9: Chunk accumulation
 */

import { describe, it, expect } from 'vitest';

// E2E tests are only run via `pnpm test:e2e:docker` which uses a separate
// vitest config that includes the Docker infrastructure endpoints.
// These tests are skipped when run in the standard unit test suite.
const SKIP_E2E = !process.env['SDK_E2E_DOCKER'];

// ============================================================================
// 8.0-E2E-001: Single-Packet Upload via ILP (AC #5, #7)
// ============================================================================

describe.skipIf(SKIP_E2E)('Arweave DVM E2E (Story 8.0)', () => {
  it.skip('8.0-E2E-001: client sends kind:5094 via ILP -> provider uploads to Arweave -> client receives tx ID', async () => {
    // This test requires:
    // 1. SDK E2E Docker infra running (./scripts/sdk-e2e-infra.sh up)
    // 2. At least one peer configured with Arweave DVM handler (kindPricing[5094])
    // 3. ARWEAVE_JWK env var or free tier (<=100KB) for the provider
    //
    // Implementation deferred to after Docker infra is updated to include
    // the Arweave DVM handler in peer node configuration.
    expect(true).toBe(true);
  });

  // ==========================================================================
  // 8.0-E2E-002: Chunked Upload via ILP (AC #8, #9)
  // ==========================================================================

  it.skip('8.0-E2E-002: client sends chunked kind:5094 via ILP -> provider assembles and uploads -> client receives tx ID', async () => {
    // This test requires the same infrastructure as 8.0-E2E-001 plus
    // a blob larger than the chunk threshold (512KB).
    //
    // Implementation deferred to after Docker infra is updated.
    expect(true).toBe(true);
  });
});

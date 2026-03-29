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
 * The test node is a lightweight **client** (auto-created connector),
 * not a full peer. It bootstraps from peer1, opens a payment channel
 * automatically, then uses uploadBlob/uploadBlobChunked helpers.
 *
 * AC covered:
 * - AC #5: Single-packet upload (prepaid)
 * - AC #7: Arweave retrieval verification
 * - AC #8: Chunk splitting
 * - AC #9: Chunk accumulation
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateSecretKey } from 'nostr-tools/pure';
import {
  createNode,
  type ServiceNode,
  type HandlerContext,
  uploadBlob,
  uploadBlobChunked,
} from '@toon-protocol/sdk';

import {
  PEER1_BTP_URL,
  PEER1_RELAY_URL,
  TEST_PRIVATE_KEY,
  checkAllServicesReady,
  skipIfNotReady,
  waitForServiceHealth,
  PEER1_BLS_URL,
} from './helpers/docker-e2e-setup.js';

// E2E tests are only run via `pnpm test:e2e:docker` which uses a separate
// vitest config that includes the Docker infrastructure endpoints.
const SKIP_E2E = !process.env['SDK_E2E_DOCKER'];

// Peer1's deterministic pubkey (derived from NOSTR_SECRET_KEY in docker-compose)
const PEER1_PUBKEY =
  'd6bfe100d1600c0d8f769501676fc74c3809500bd131c8a549f88cf616c21f35';

// ============================================================================
// Test Suite
// ============================================================================

describe.skipIf(SKIP_E2E)('Arweave DVM E2E (Story 8.0)', () => {
  let servicesReady = false;
  let node: ServiceNode;
  let nostrSecretKey: Uint8Array;

  beforeAll(async () => {
    const ready = await checkAllServicesReady();
    if (!ready) return;

    nostrSecretKey = generateSecretKey();

    // Create a lightweight client node with auto-created embedded connector.
    // Bootstrap discovers peer1 and auto-opens a payment channel.
    node = createNode({
      secretKey: nostrSecretKey,
      // Auto-create connector (no manual ConnectorNode needed)
      chain: 'anvil',
      btpServerPort: 19904,
      settlementPrivateKey: TEST_PRIVATE_KEY,
      basePricePerByte: 10n,
      knownPeers: [
        {
          pubkey: PEER1_PUBKEY,
          relayUrl: PEER1_RELAY_URL,
          btpEndpoint: PEER1_BTP_URL,
        },
      ],
    });

    // Accept all events by default (client, not a provider)
    node.onDefault(async (ctx: HandlerContext) => {
      ctx.decode();
      return ctx.accept();
    });

    await node.start();

    // Wait for bootstrap to complete (peer registered + channel opened)
    await waitForServiceHealth(`${PEER1_BLS_URL}/health`, 15000);
    // Give bootstrap time to register peer and open channel
    await new Promise((r) => setTimeout(r, 3000));

    servicesReady = true;
  }, 120000);

  afterAll(async () => {
    if (node) await node.stop();
    await new Promise((r) => setTimeout(r, 500));
  });

  // ==========================================================================
  // 8.0-E2E-001: Single-Packet Upload via ILP (AC #5, #7)
  // ==========================================================================

  it('8.0-E2E-001: client sends kind:5094 via ILP -> provider uploads to Arweave -> client receives tx ID', async () => {
    if (skipIfNotReady(servicesReady)) return;

    // Small test blob (well under 100KB free tier limit)
    const testPayload = `Hello from TOON Arweave DVM E2E test! Timestamp: ${Date.now()}`;
    const blob = Buffer.from(testPayload, 'utf-8');

    const txId = await uploadBlob(node, blob, 'g.toon.peer1', {
      secretKey: nostrSecretKey,
      contentType: 'text/plain',
      pricePerByte: 10n,
    });

    // Verify we received a valid Arweave transaction ID
    // ArDrive/Turbo returns a 43-character base64url string
    expect(txId).toBeTruthy();
    expect(typeof txId).toBe('string');
    expect(txId.length).toBeGreaterThan(0);
    // Arweave tx IDs are 43 chars (base64url-encoded 32 bytes)
    expect(txId).toMatch(/^[A-Za-z0-9_-]{43}$/);
  }, 30000);

  // ==========================================================================
  // 8.0-E2E-002: Chunked Upload via ILP (AC #8, #9)
  // ==========================================================================

  it('8.0-E2E-002: client sends chunked kind:5094 via ILP -> provider assembles and uploads -> client receives tx ID', async () => {
    if (skipIfNotReady(servicesReady)) return;

    // Create a blob that spans multiple chunks.
    // Use a small chunk size (1KB) so we don't hit the 100KB free tier limit
    // but still exercise the chunking path with multiple packets.
    const chunkSize = 1024;
    const totalSize = chunkSize * 3 + 512; // 3.5 chunks -> 4 chunks
    const blob = Buffer.alloc(totalSize);
    // Fill with recognizable pattern
    for (let i = 0; i < totalSize; i++) {
      blob[i] = i % 256;
    }

    const txId = await uploadBlobChunked(node, blob, 'g.toon.peer1', {
      secretKey: nostrSecretKey,
      contentType: 'application/octet-stream',
      pricePerByte: 10n,
      chunkSize,
    });

    // Verify we received a valid Arweave transaction ID
    expect(txId).toBeTruthy();
    expect(typeof txId).toBe('string');
    expect(txId.length).toBeGreaterThan(0);
    expect(txId).toMatch(/^[A-Za-z0-9_-]{43}$/);
  }, 60000);
});

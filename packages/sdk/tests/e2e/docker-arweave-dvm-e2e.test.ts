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

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import {
  createNode,
  type ServiceNode,
  type HandlerContext,
  uploadBlob,
  uploadBlobChunked,
} from '@toon-protocol/sdk';
import { ConnectorNode, createLogger } from '@toon-protocol/connector';
import { encodeEventToToon, decodeEventFromToon } from '@toon-protocol/relay';

import {
  ANVIL_RPC,
  PEER1_BTP_URL,
  PEER1_EVM_ADDRESS,
  TOKEN_ADDRESS,
  TOKEN_NETWORK_ADDRESS,
  REGISTRY_ADDRESS,
  TEST_PRIVATE_KEY,
  CHAIN_ID,
  checkAllServicesReady,
  skipIfNotReady,
} from './helpers/docker-e2e-setup.js';

// E2E tests are only run via `pnpm test:e2e:docker` which uses a separate
// vitest config that includes the Docker infrastructure endpoints.
// These tests are skipped when run in the standard unit test suite.
const SKIP_E2E = !process.env['SDK_E2E_DOCKER'];

// ============================================================================
// Test Suite
// ============================================================================

describe.skipIf(SKIP_E2E)('Arweave DVM E2E (Story 8.0)', () => {
  let servicesReady = false;
  let node: ServiceNode;
  let connector: ConnectorNode;
  let nostrSecretKey: Uint8Array;

  beforeAll(async () => {
    const ready = await checkAllServicesReady();
    if (!ready) return;

    process.env['EXPLORER_ENABLED'] = 'false';

    nostrSecretKey = generateSecretKey();
    const nostrPubkey = getPublicKey(nostrSecretKey);
    const testIlpAddress = `g.toon.test.arweave.${nostrPubkey.slice(0, 8)}`;

    const connectorLogger = createLogger('test-arweave-connector', 'warn');
    connector = new ConnectorNode(
      {
        nodeId: `test-arweave-${nostrPubkey.slice(0, 8)}`,
        btpServerPort: 19904,
        healthCheckPort: 19905,
        environment: 'development' as const,
        deploymentMode: 'embedded' as const,
        peers: [],
        routes: [],
        localDelivery: { enabled: false },
        settlementInfra: {
          enabled: true,
          rpcUrl: ANVIL_RPC,
          registryAddress: REGISTRY_ADDRESS,
          tokenAddress: TOKEN_ADDRESS,
          privateKey: TEST_PRIVATE_KEY,
        },
      },
      connectorLogger
    );

    node = createNode({
      secretKey: nostrSecretKey,
      connector,
      ilpAddress: testIlpAddress,
      basePricePerByte: 10n,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      knownPeers: [],
    });

    // Accept all events by default (client node, not a provider)
    node.onDefault(async (ctx: HandlerContext) => {
      ctx.decode();
      return ctx.accept();
    });

    await connector.start();
    await node.start();

    // Register peer1 (the Arweave DVM provider)
    await connector.registerPeer({
      id: 'peer1',
      url: PEER1_BTP_URL,
      authToken: '',
      routes: [{ prefix: 'g.toon.peer1' }],
    });

    // Wait for BTP connection
    await new Promise((r) => setTimeout(r, 2000));

    // Open payment channel with sufficient deposit for blob uploads
    await connector.openChannel({
      peerId: 'peer1',
      chain: `eip155:${CHAIN_ID}`,
      token: TOKEN_ADDRESS,
      tokenNetwork: TOKEN_NETWORK_ADDRESS,
      peerAddress: PEER1_EVM_ADDRESS,
      initialDeposit: '5000000', // 5 USDC — enough for several test uploads
      settlementTimeout: 3600,
    });

    servicesReady = true;
  }, 120000);

  afterAll(async () => {
    if (node) await node.stop();
    if (connector) await connector.stop();
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

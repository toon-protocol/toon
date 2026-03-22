/**
 * ATDD tests for Story 7.6: SDK claimPrefix() convenience method (AC #7, #8)
 *
 * Tests for the SDK claimPrefix() convenience method on ServiceNode
 * that builds a prefix claim event and sends it via publishEvent().
 *
 * Validates:
 * - claimPrefix() calls publishEvent() with correct amount from upstream's prefixPricing
 * - claimPrefix() builds a PrefixClaimEvent with the requested prefix
 *
 * Test IDs from test-design-epic-7.md:
 * - T-7.7-11 [P1]: SDK claimPrefix calls publishEvent with correct amount
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createNode } from './create-node.js';
import { NodeError } from './errors.js';
import type {
  HandlePacketRequest,
  HandlePacketResponse,
  EmbeddableConnectorLike,
} from '@toon-protocol/core';
import type { SendPacketParams, SendPacketResult } from '@toon-protocol/core';
import type { RegisterPeerParams } from '@toon-protocol/core';

// Prevent live relay connections
vi.mock('nostr-tools');

// ============================================================================
// Deterministic test fixtures
// ============================================================================

/** Fixed secret key for deterministic identity derivation (32 bytes) */
const TEST_SECRET_KEY = Uint8Array.from(Buffer.from('a'.repeat(64), 'hex'));

/**
 * Creates a mock connector that records sendPacket calls.
 */
function createMockConnector(
  sendPacketResult?: SendPacketResult
): EmbeddableConnectorLike & {
  sendPacketCalls: SendPacketParams[];
} {
  const calls: SendPacketParams[] = [];
  return {
    sendPacketCalls: calls,
    async sendPacket(params: SendPacketParams): Promise<SendPacketResult> {
      calls.push(params);
      return (
        sendPacketResult ?? {
          type: 'fulfill',
          fulfillment: Buffer.from('test-fulfillment'),
        }
      );
    },
    async registerPeer(_params: RegisterPeerParams): Promise<void> {},
    async removePeer(_peerId: string): Promise<void> {},
    setPacketHandler(
      _handler: (
        req: HandlePacketRequest
      ) => HandlePacketResponse | Promise<HandlePacketResponse>
    ): void {},
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('claimPrefix() SDK convenience method (Story 7.6, AC #7, #8)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // T-7.7-11: claimPrefix calls publishEvent with correct amount
  // --------------------------------------------------------------------------

  it('T-7.7-11 [P1]: claimPrefix() calls publishEvent() with amount from upstream prefixPricing', async () => {
    // Arrange
    const connector = createMockConnector({
      type: 'fulfill',
      fulfillment: Buffer.from('test-fulfillment'),
    });
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      knownPeers: [],
    });
    await node.start();

    // Act -- claim a prefix from an upstream node
    const result = await node.claimPrefix('useast', 'g.toon.upstream', {
      prefixPrice: 1000000n,
    });

    // Assert -- publishEvent was called (via connector.sendPacket)
    expect(connector.sendPacketCalls.length).toBe(1);

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- test assertion
    const call = connector.sendPacketCalls[0]!;
    // Destination matches the upstream
    expect(call.destination).toBe('g.toon.upstream');
    // Amount should include the prefix price
    expect(call.amount).toBe(1000000n);
    // Result should be successful
    expect(result.success).toBe(true);

    // Cleanup
    await node.stop();
  });

  // --------------------------------------------------------------------------
  // claimPrefix builds correct event kind
  // --------------------------------------------------------------------------

  it('[P1] claimPrefix() sends a Kind 10034 prefix claim event', async () => {
    // Arrange
    const connector = createMockConnector({
      type: 'fulfill',
      fulfillment: Buffer.from('test-fulfillment'),
    });
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      knownPeers: [],
    });
    await node.start();

    // Act
    await node.claimPrefix('euwest', 'g.toon.upstream', {
      prefixPrice: 500000n,
    });

    // Assert -- the data sent contains a Kind 10034 event
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- test assertion
    const call = connector.sendPacketCalls[0]!;
    expect(call.data).toBeInstanceOf(Uint8Array);
    expect(call.data.length).toBeGreaterThan(0);

    // Decode the TOON data to verify it's a prefix claim event
    const { decodeEventFromToon } = await import('@toon-protocol/core/toon');
    const decoded = decodeEventFromToon(call.data);
    expect(decoded.kind).toBe(10034);

    // Verify the content contains the requested prefix
    const content = JSON.parse(decoded.content);
    expect(content.requestedPrefix).toBe('euwest');

    // Cleanup
    await node.stop();
  });

  // --------------------------------------------------------------------------
  // claimPrefix throws when no prefixPrice and no discovered peer
  // --------------------------------------------------------------------------

  it('[P1] claimPrefix() throws NodeError when no prefixPrice provided and upstream not in discovery', async () => {
    // Arrange
    const connector = createMockConnector({
      type: 'fulfill',
      fulfillment: Buffer.from('test-fulfillment'),
    });
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      knownPeers: [],
    });
    await node.start();

    // Act & Assert -- no prefixPrice option, no discovered peer -> throws
    await expect(node.claimPrefix('useast', 'g.toon.upstream')).rejects.toThrow(
      NodeError
    );

    await expect(node.claimPrefix('useast', 'g.toon.upstream')).rejects.toThrow(
      /prefix pricing not found in discovery/
    );

    // Assert -- no ILP packet sent
    expect(connector.sendPacketCalls.length).toBe(0);

    // Cleanup
    await node.stop();
  });

  // --------------------------------------------------------------------------
  // claimPrefix throws when node not started
  // --------------------------------------------------------------------------

  it('[P1] claimPrefix() throws NodeError for invalid prefix before sending ILP packet', async () => {
    // Arrange
    const connector = createMockConnector({
      type: 'fulfill',
      fulfillment: Buffer.from('test-fulfillment'),
    });
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      knownPeers: [],
    });
    await node.start();

    // Act & Assert -- too short prefix (min 2 chars)
    await expect(
      node.claimPrefix('a', 'g.toon.upstream', { prefixPrice: 1000n })
    ).rejects.toThrow(NodeError);

    await expect(
      node.claimPrefix('a', 'g.toon.upstream', { prefixPrice: 1000n })
    ).rejects.toThrow(/Cannot claim prefix/);

    // Assert -- no ILP packet was sent (fail-fast before payment)
    expect(connector.sendPacketCalls.length).toBe(0);

    // Also test reserved word
    await expect(
      node.claimPrefix('toon', 'g.toon.upstream', { prefixPrice: 1000n })
    ).rejects.toThrow(/reserved/);

    // Assert -- still no ILP packet sent
    expect(connector.sendPacketCalls.length).toBe(0);

    // Cleanup
    await node.stop();
  });

  it('[P1] claimPrefix() throws NodeError when node not started', async () => {
    // Arrange -- do NOT call start()
    const connector = createMockConnector();
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
    });

    // Act & Assert
    await expect(
      node.claimPrefix('useast', 'g.toon.upstream', { prefixPrice: 1000n })
    ).rejects.toThrow(NodeError);

    await expect(
      node.claimPrefix('useast', 'g.toon.upstream', { prefixPrice: 1000n })
    ).rejects.toThrow(/node not started/);
  });
});

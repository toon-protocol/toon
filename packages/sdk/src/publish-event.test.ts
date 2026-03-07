/**
 * Unit Tests: publishEvent() on ServiceNode (Story 2.6)
 *
 * Acceptance Criteria covered:
 *   AC#1 - TOON-encode, price, base64, sendIlpPacket
 *   AC#2 - NodeError when destination missing
 *   AC#3 - NodeError when node not started
 *   AC#4 - PublishEventResult success/failure shapes
 *   AC#5 - PublishEventResult type exported (verified by type import from SDK index below)
 *   AC#6 - All existing tests still pass (run full suite)
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { NostrEvent } from 'nostr-tools/pure';
import { createNode } from './create-node.js';
import { NodeError } from './errors.js';

// AC#5: Verify PublishEventResult is importable from the SDK public API surface
import type { PublishEventResult } from './index.js';

// Compile-time assertion: ensure the type resolves through the SDK index
const _typeCheck: PublishEventResult = {
  success: true,
  eventId: 'test',
  fulfillment: 'test',
};
void _typeCheck;

// Prevent live relay connections via SimplePool (project rule: always mock nostr-tools in tests)
vi.mock('nostr-tools');
import type {
  HandlePacketRequest,
  HandlePacketResponse,
  EmbeddableConnectorLike,
} from '@crosstown/core';
import type { SendPacketParams, SendPacketResult } from '@crosstown/core';
import type { RegisterPeerParams } from '@crosstown/core';

// ---------------------------------------------------------------------------
// Test Fixtures: Deterministic mock data
// ---------------------------------------------------------------------------

/** Fixed secret key for deterministic identity derivation (32 bytes, hex-decoded) */
const TEST_SECRET_KEY = Uint8Array.from(Buffer.from('a'.repeat(64), 'hex'));

/** Deterministic Nostr event for all publishEvent tests */
function createTestEvent(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: 'a'.repeat(64),
    pubkey: 'b'.repeat(64),
    created_at: 1700000000,
    kind: 1,
    tags: [],
    content: 'Hello, Crosstown!',
    sig: 'c'.repeat(128),
    ...overrides,
  };
}

/**
 * Creates a mock connector that records sendPacket calls and returns
 * configurable results.
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('publishEvent() unit tests (Story 2.6)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // AC#1: TOON-encode, compute amount, send via sendIlpPacket
  // -------------------------------------------------------------------------

  it('[P0] publishEvent() TOON-encodes the event and sends via connector.sendPacket() with correct parameters (AC#1)', async () => {
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

    const event = createTestEvent();

    // Act
    await node.publishEvent(event, {
      destination: 'g.peer.address',
    });

    // Assert -- sendPacket was called
    expect(connector.sendPacketCalls.length).toBe(1);
    const call = connector.sendPacketCalls[0];

    // Assert -- destination is passed through
    expect(call.destination).toBe('g.peer.address');

    // Assert -- data is a Uint8Array (TOON-encoded then base64'd then decoded back by DirectRuntimeClient)
    expect(call.data).toBeInstanceOf(Uint8Array);
    expect(call.data.length).toBeGreaterThan(0);

    // Assert -- amount is a bigint computed from TOON length
    expect(typeof call.amount).toBe('bigint');
    expect(call.amount).toBeGreaterThan(0n);

    // Cleanup
    await node.stop();
  });

  it('[P0] publishEvent() computes correct amount as basePricePerByte * toonData.length (AC#1)', async () => {
    // Arrange -- use a known basePricePerByte to verify computation
    const connector = createMockConnector({
      type: 'fulfill',
      fulfillment: Buffer.from('test-fulfillment'),
    });
    const basePricePerByte = 20n;
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      basePricePerByte,
      knownPeers: [],
    });
    await node.start();

    const event = createTestEvent();

    // Act
    await node.publishEvent(event, { destination: 'g.peer.address' });

    // Assert -- amount = basePricePerByte * toonData.length
    const call = connector.sendPacketCalls[0];
    // The amount should be 20n * (TOON byte length), and it must be > 0
    expect(call.amount).toBeGreaterThan(0n);
    // Verify it's a multiple of basePricePerByte
    expect(call.amount % basePricePerByte).toBe(0n);

    // Cleanup
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // AC#4: Success result shape
  // -------------------------------------------------------------------------

  it('[P0] publishEvent() returns { success: true, eventId, fulfillment } when connector accepts (AC#4)', async () => {
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

    const event = createTestEvent({ id: 'dd'.repeat(32) });

    // Act
    const result = await node.publishEvent(event, {
      destination: 'g.peer.address',
    });

    // Assert -- success result shape
    expect(result.success).toBe(true);
    expect(result.eventId).toBe('dd'.repeat(32));
    expect(result.fulfillment).toBeDefined();
    expect(result.fulfillment?.length).toBeGreaterThan(0);

    // Cleanup
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // AC#4: Rejection result shape
  // -------------------------------------------------------------------------

  it('[P0] publishEvent() returns { success: false, eventId, code, message } when connector rejects (AC#4)', async () => {
    // Arrange
    const connector = createMockConnector({
      type: 'reject',
      code: 'F02',
      message: 'No route to destination',
    });
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      knownPeers: [],
    });
    await node.start();

    const event = createTestEvent({ id: 'ee'.repeat(32) });

    // Act
    const result = await node.publishEvent(event, {
      destination: 'g.unreachable.peer',
    });

    // Assert -- rejection result shape
    expect(result.success).toBe(false);
    expect(result.eventId).toBe('ee'.repeat(32));
    expect(result.code).toBe('F02');
    expect(result.message).toBe('No route to destination');

    // Cleanup
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // AC#3: Not-started guard
  // -------------------------------------------------------------------------

  it('[P1] publishEvent() throws NodeError when node not started (AC#3)', async () => {
    // Arrange -- do NOT call start()
    const connector = createMockConnector();
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
    });

    const event = createTestEvent();

    // Act & Assert
    await expect(
      node.publishEvent(event, { destination: 'g.peer.address' })
    ).rejects.toThrow(NodeError);

    await expect(
      node.publishEvent(event, { destination: 'g.peer.address' })
    ).rejects.toThrow(/Cannot publish: node not started/);
  });

  // -------------------------------------------------------------------------
  // AC#2: Missing destination (options undefined)
  // -------------------------------------------------------------------------

  it('[P1] publishEvent() throws NodeError when options is undefined (AC#2)', async () => {
    // Arrange
    const connector = createMockConnector();
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      knownPeers: [],
    });
    await node.start();

    const event = createTestEvent();

    // Act & Assert -- call without options
    await expect(node.publishEvent(event)).rejects.toThrow(NodeError);
    await expect(node.publishEvent(event)).rejects.toThrow(
      /destination is required/
    );

    // Cleanup
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // AC#2: Missing destination (empty string)
  // -------------------------------------------------------------------------

  it('[P1] publishEvent() throws NodeError when destination is empty string (AC#2)', async () => {
    // Arrange
    const connector = createMockConnector();
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      knownPeers: [],
    });
    await node.start();

    const event = createTestEvent();

    // Act & Assert -- call with empty destination
    await expect(node.publishEvent(event, { destination: '' })).rejects.toThrow(
      NodeError
    );
    await expect(node.publishEvent(event, { destination: '' })).rejects.toThrow(
      /destination is required/
    );

    // Cleanup
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // AC#1: Custom basePricePerByte from config
  // -------------------------------------------------------------------------

  it('[P2] publishEvent() uses custom basePricePerByte from config when provided (AC#1)', async () => {
    // Arrange
    const connector = createMockConnector({
      type: 'fulfill',
      fulfillment: Buffer.from('test-fulfillment'),
    });
    const customPrice = 50n;
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      basePricePerByte: customPrice,
      knownPeers: [],
    });
    await node.start();

    const event = createTestEvent();

    // Act
    await node.publishEvent(event, { destination: 'g.peer.address' });

    // Assert -- amount should be a multiple of customPrice
    const call = connector.sendPacketCalls[0];
    expect(call.amount % customPrice).toBe(0n);
    // With 50n per byte the amount should be higher than with the default 10n
    expect(call.amount).toBeGreaterThan(0n);

    // Cleanup
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // AC#1: Default basePricePerByte (10n) when not configured
  // -------------------------------------------------------------------------

  it('[P2] publishEvent() uses default basePricePerByte (10n) when not configured (AC#1)', async () => {
    // Arrange -- omit basePricePerByte from config
    const connector = createMockConnector({
      type: 'fulfill',
      fulfillment: Buffer.from('test-fulfillment'),
    });
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      // basePricePerByte intentionally omitted (defaults to 10n)
      knownPeers: [],
    });
    await node.start();

    const event = createTestEvent();

    // Act
    await node.publishEvent(event, { destination: 'g.peer.address' });

    // Assert -- amount should be a multiple of 10n (default basePricePerByte)
    const call = connector.sendPacketCalls[0];
    expect(call.amount % 10n).toBe(0n);
    expect(call.amount).toBeGreaterThan(0n);

    // Cleanup
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // AC#3: Not-started guard after stop()
  // -------------------------------------------------------------------------

  it('[P2] publishEvent() throws NodeError after node.stop() is called (AC#3)', async () => {
    // Arrange -- start then stop
    const connector = createMockConnector();
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      knownPeers: [],
    });
    await node.start();
    await node.stop();

    const event = createTestEvent();

    // Act & Assert -- should throw because stop() resets started flag
    await expect(
      node.publishEvent(event, { destination: 'g.peer.address' })
    ).rejects.toThrow(NodeError);

    await expect(
      node.publishEvent(event, { destination: 'g.peer.address' })
    ).rejects.toThrow(/Cannot publish: node not started/);
  });

  // -------------------------------------------------------------------------
  // AC#1: Exact amount verification
  // -------------------------------------------------------------------------

  it('[P2] publishEvent() computes exact amount matching basePricePerByte * TOON byte length (AC#1)', async () => {
    // Arrange -- use default encoder to get known TOON length
    const { encodeEventToToon } = await import('@crosstown/core/toon');
    const connector = createMockConnector({
      type: 'fulfill',
      fulfillment: Buffer.from('test-fulfillment'),
    });
    const basePricePerByte = 10n;
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      basePricePerByte,
      knownPeers: [],
    });
    await node.start();

    const event = createTestEvent();
    const expectedToonLength = BigInt(encodeEventToToon(event).length);
    const expectedAmount = basePricePerByte * expectedToonLength;

    // Act
    await node.publishEvent(event, { destination: 'g.peer.address' });

    // Assert -- exact amount match
    const call = connector.sendPacketCalls[0];
    expect(call.amount).toBe(expectedAmount);

    // Cleanup
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // Error wrapping: TOON encoder failure
  // -------------------------------------------------------------------------

  it('[P2] publishEvent() wraps TOON encoder errors in NodeError (error path)', async () => {
    // Arrange -- custom encoder that throws
    const connector = createMockConnector();
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      knownPeers: [],
      toonEncoder: () => {
        throw new Error('TOON encoding failed: invalid event');
      },
    });
    await node.start();

    const event = createTestEvent();

    // Act & Assert -- should wrap in NodeError with message prefix
    await expect(
      node.publishEvent(event, { destination: 'g.peer.address' })
    ).rejects.toThrow(NodeError);

    await expect(
      node.publishEvent(event, { destination: 'g.peer.address' })
    ).rejects.toThrow(/Failed to publish event:.*TOON encoding failed/);

    // Cleanup
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // Error wrapping: sendPacket throws a generic Error (G1)
  // -------------------------------------------------------------------------

  it('[P1] publishEvent() wraps connector sendPacket errors in NodeError (AC#1 error path)', async () => {
    // Arrange -- connector.sendPacket throws a generic Error
    const connector = createMockConnector();
    connector.sendPacket = async () => {
      throw new Error('Connection refused: peer unreachable');
    };
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      knownPeers: [],
    });
    await node.start();

    const event = createTestEvent();

    // Act & Assert -- should wrap generic Error in NodeError with "Failed to publish event:" prefix
    await expect(
      node.publishEvent(event, { destination: 'g.peer.address' })
    ).rejects.toThrow(NodeError);

    await expect(
      node.publishEvent(event, { destination: 'g.peer.address' })
    ).rejects.toThrow(/Failed to publish event:.*Connection refused/);

    // Cleanup
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // Error wrapping: sendPacket throws a non-Error value (G2)
  // -------------------------------------------------------------------------

  it('[P2] publishEvent() wraps non-Error thrown values in NodeError with String() conversion', async () => {
    // Arrange -- connector.sendPacket throws a string (non-Error value)
    const connector = createMockConnector();
    connector.sendPacket = async () => {
      throw 'raw string error from transport layer' as unknown;
    };
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      knownPeers: [],
    });
    await node.start();

    const event = createTestEvent();

    // Act & Assert -- should wrap non-Error value via String() in NodeError
    await expect(
      node.publishEvent(event, { destination: 'g.peer.address' })
    ).rejects.toThrow(NodeError);

    await expect(
      node.publishEvent(event, { destination: 'g.peer.address' })
    ).rejects.toThrow(/Failed to publish event:/);

    // Cleanup
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // Error propagation: NodeError thrown inside try block (G6)
  // -------------------------------------------------------------------------

  it('[P1] publishEvent() propagates NodeError directly without re-wrapping', async () => {
    // Arrange -- custom encoder that throws a NodeError (not a plain Error)
    const connector = createMockConnector();
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      knownPeers: [],
      toonEncoder: () => {
        throw new NodeError('Custom NodeError from encoder');
      },
    });
    await node.start();

    const event = createTestEvent();

    // Act & Assert -- NodeError should propagate directly without "Failed to publish event:" prefix
    await expect(
      node.publishEvent(event, { destination: 'g.peer.address' })
    ).rejects.toThrow(NodeError);

    // Verify it is the ORIGINAL NodeError message (not wrapped with prefix)
    await expect(
      node.publishEvent(event, { destination: 'g.peer.address' })
    ).rejects.toThrow('Custom NodeError from encoder');

    // Verify it does NOT have the wrapping prefix
    try {
      await node.publishEvent(event, { destination: 'g.peer.address' });
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(NodeError);
      expect((error as NodeError).message).not.toContain(
        'Failed to publish event:'
      );
    }

    // Cleanup
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // Proportional amount scaling with content size (G5)
  // -------------------------------------------------------------------------

  it('[P2] publishEvent() scales amount proportionally with event content size', async () => {
    // Arrange -- two events with different content sizes
    const connector = createMockConnector({
      type: 'fulfill',
      fulfillment: Buffer.from('test-fulfillment'),
    });
    const basePricePerByte = 10n;
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      basePricePerByte,
      knownPeers: [],
    });
    await node.start();

    const smallEvent = createTestEvent({ content: 'Hi' });
    const largeEvent = createTestEvent({
      content: 'A'.repeat(1000),
    });

    // Act -- publish both events
    await node.publishEvent(smallEvent, { destination: 'g.peer.address' });
    await node.publishEvent(largeEvent, { destination: 'g.peer.address' });

    // Assert -- larger content should produce larger amount
    const smallCall = connector.sendPacketCalls[0];
    const largeCall = connector.sendPacketCalls[1];
    expect(largeCall.amount).toBeGreaterThan(smallCall.amount);

    // Both amounts should be multiples of basePricePerByte
    expect(smallCall.amount % basePricePerByte).toBe(0n);
    expect(largeCall.amount % basePricePerByte).toBe(0n);

    // Cleanup
    await node.stop();
  });
});

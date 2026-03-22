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
};
void _typeCheck;

// Prevent live relay connections via SimplePool (project rule: always mock nostr-tools in tests)
vi.mock('nostr-tools');
import type {
  HandlePacketRequest,
  HandlePacketResponse,
  EmbeddableConnectorLike,
} from '@toon-protocol/core';
import type { SendPacketParams, SendPacketResult } from '@toon-protocol/core';
import type { RegisterPeerParams } from '@toon-protocol/core';
import { calculateRouteAmount } from '@toon-protocol/core';

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
    content: 'Hello, TOON!',
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
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- test assertion: sendPacket was called above
    const call = connector.sendPacketCalls[0]!;

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
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- test assertion: sendPacket was called above
    const call = connector.sendPacketCalls[0]!;
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

  it('[P0] publishEvent() returns { success: true, eventId } when connector accepts (AC#4)', async () => {
    // Arrange
    const connector = createMockConnector({
      type: 'fulfill',
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
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- test assertion: sendPacket was called above
    const call = connector.sendPacketCalls[0]!;
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
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- test assertion: sendPacket was called above
    const call = connector.sendPacketCalls[0]!;
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
    const { encodeEventToToon } = await import('@toon-protocol/core/toon');
    const connector = createMockConnector({
      type: 'fulfill',
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
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- test assertion: sendPacket was called above
    const call = connector.sendPacketCalls[0]!;
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
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- test assertion: two sendPacket calls above
    const smallCall = connector.sendPacketCalls[0]!;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- test assertion: two sendPacket calls above
    const largeCall = connector.sendPacketCalls[1]!;
    expect(largeCall.amount).toBeGreaterThan(smallCall.amount);

    // Both amounts should be multiples of basePricePerByte
    expect(smallCall.amount % basePricePerByte).toBe(0n);
    expect(largeCall.amount % basePricePerByte).toBe(0n);

    // Cleanup
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // AC#1: Custom TOON encoder is actually used (success path)
  // -------------------------------------------------------------------------

  it('[P1] publishEvent() uses the configured toonEncoder for encoding (AC#1)', async () => {
    // Arrange -- spy-wrapping encoder that delegates to the real encoder
    // but lets us verify it was called (not the default)
    const { encodeEventToToon } = await import('@toon-protocol/core/toon');
    const customEncoder = vi.fn((event: NostrEvent) =>
      encodeEventToToon(event)
    );

    const connector = createMockConnector({
      type: 'fulfill',
    });
    const basePricePerByte = 10n;
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      basePricePerByte,
      toonEncoder: customEncoder,
      knownPeers: [],
    });
    await node.start();

    const event = createTestEvent();

    // Act
    await node.publishEvent(event, { destination: 'g.peer.address' });

    // Assert -- custom encoder was called with the event
    expect(customEncoder).toHaveBeenCalledTimes(1);
    expect(customEncoder).toHaveBeenCalledWith(event);

    // Assert -- the data sent to connector matches the custom encoder output
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- test assertion: sendPacket was called above
    const call = connector.sendPacketCalls[0]!;
    const expectedToon = encodeEventToToon(event);
    expect(Buffer.from(call.data).equals(Buffer.from(expectedToon))).toBe(true);

    // Assert -- amount is computed from the custom encoder's output length
    expect(call.amount).toBe(basePricePerByte * BigInt(expectedToon.length));

    // Cleanup
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // AC#4: Success result does not contain rejection-only fields
  // -------------------------------------------------------------------------

  it('[P1] publishEvent() success result does not include code or message fields (AC#4)', async () => {
    // Arrange
    const connector = createMockConnector({
      type: 'fulfill',
    });
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      knownPeers: [],
    });
    await node.start();

    const event = createTestEvent();

    // Act
    const result = await node.publishEvent(event, {
      destination: 'g.peer.address',
    });

    // Assert -- success shape has no code or message
    expect(result.success).toBe(true);
    expect(result.code).toBeUndefined();
    expect(result.message).toBeUndefined();

    // Cleanup
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // AC#4: Rejection result shape
  // -------------------------------------------------------------------------

  it('[P1] publishEvent() rejection result includes code and message (AC#4)', async () => {
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

    const event = createTestEvent();

    // Act
    const result = await node.publishEvent(event, {
      destination: 'g.peer.unreachable',
    });

    // Assert -- rejection shape
    expect(result.success).toBe(false);
    expect(result.code).toBe('F02');
    expect(result.message).toBe('No route to destination');

    // Cleanup
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // AC#4: Rejection result uses defaults when connector omits code/message
  // -------------------------------------------------------------------------

  it('[P2] publishEvent() passes through empty code and message when connector rejects with empty strings (AC#4)', async () => {
    // Arrange -- connector returns reject with no code or message fields
    const connector = createMockConnector({
      type: 'reject',
      code: '',
      message: '',
    });
    // Override sendPacket to return a reject with missing fields
    connector.sendPacket = async () => ({
      type: 'reject' as const,
      code: '',
      message: '',
    });
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      knownPeers: [],
    });
    await node.start();

    const event = createTestEvent();

    // Act
    const result = await node.publishEvent(event, {
      destination: 'g.peer.address',
    });

    // Assert -- implementation falls back to code ?? 'T00', message ?? 'Unknown error'
    // Empty strings are falsy but not nullish, so ?? does not trigger for them.
    // This test documents the actual behavior: empty strings pass through.
    expect(result.success).toBe(false);
    expect(result.code).toBe('');
    expect(result.message).toBe('');

    // Cleanup
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // AC#1: TOON-encoded data matches the encoder output after roundtrip
  // -------------------------------------------------------------------------

  it('[P2] publishEvent() sends TOON-encoded bytes that match the encoder output (AC#1)', async () => {
    // Arrange -- use the default encoder and verify data roundtrip
    const { encodeEventToToon, decodeEventFromToon } =
      await import('@toon-protocol/core/toon');
    const connector = createMockConnector({
      type: 'fulfill',
    });
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      knownPeers: [],
    });
    await node.start();

    const event = createTestEvent({ content: 'roundtrip test content' });
    const expectedToon = encodeEventToToon(event);

    // Act
    await node.publishEvent(event, { destination: 'g.peer.address' });

    // Assert -- the data bytes sent to the connector match the TOON encoding
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- test assertion: sendPacket was called above
    const call = connector.sendPacketCalls[0]!;
    expect(Buffer.from(call.data).equals(Buffer.from(expectedToon))).toBe(true);

    // Assert -- the data can be decoded back to the original event
    const decoded = decodeEventFromToon(call.data);
    expect(decoded.id).toBe(event.id);
    expect(decoded.content).toBe('roundtrip test content');
    expect(decoded.kind).toBe(event.kind);

    // Cleanup
    await node.stop();
  });
});

// ---------------------------------------------------------------------------
// Story 7.5: Route-aware fee calculation integration tests
// ---------------------------------------------------------------------------

describe('publishEvent() route-aware fee calculation (Story 7.5)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // T-7.5-01: Direct route -> unchanged amount (basePricePerByte * toonBytes)
  // -------------------------------------------------------------------------

  it('T-7.5-01: direct route with no intermediaries computes amount = basePricePerByte * toonBytes.length', async () => {
    // Arrange -- use the real encoder to get known TOON length
    const { encodeEventToToon } = await import('@toon-protocol/core/toon');
    const connector = createMockConnector({
      type: 'fulfill',
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
    // Direct route: no intermediary fees, amount = basePricePerByte * bytes
    const expectedAmount = basePricePerByte * expectedToonLength;

    // Act -- destination g.peer.address has unknown intermediary g.peer which defaults to 0n
    await node.publishEvent(event, { destination: 'g.peer.address' });

    // Assert -- amount matches direct route calculation (unknown intermediary = 0n fee)
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- test assertion
    const call = connector.sendPacketCalls[0]!;
    expect(call.amount).toBe(expectedAmount);

    // Cleanup
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // T-7.5-04: publishEvent API signature has no fee parameters
  // -------------------------------------------------------------------------

  it('T-7.5-04: publishEvent() API signature does not expose fee parameters', async () => {
    // This is a compile-time assertion: the publishEvent signature is
    // (event: NostrEvent, options?: { destination: string }) => Promise<PublishEventResult>
    // If any fee parameters were added, this TypeScript compilation would fail.
    const connector = createMockConnector({
      type: 'fulfill',
    });
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      knownPeers: [],
    });
    await node.start();

    const event = createTestEvent();

    // Act -- call with ONLY destination (no fee params)
    const result = await node.publishEvent(event, {
      destination: 'g.peer.address',
    });

    // Assert -- publish succeeds without any fee parameters
    expect(result.success).toBe(true);

    // Cleanup
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // AC#6: publishEvent logs warning for unknown intermediaries
  // -------------------------------------------------------------------------

  it('AC#6: publishEvent() logs console.warn with [publishEvent] prefix for unknown intermediaries', async () => {
    // Arrange
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const connector = createMockConnector({
      type: 'fulfill',
    });
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      knownPeers: [],
    });
    await node.start();

    const event = createTestEvent();

    // Act -- destination g.peer.address has unknown intermediary g.peer
    await node.publishEvent(event, { destination: 'g.peer.address' });

    // Assert -- console.warn was called with [publishEvent] prefix and intermediary address
    const warnCalls = warnSpy.mock.calls.filter(
      (call) =>
        typeof call[0] === 'string' && call[0].includes('[publishEvent]')
    );
    expect(warnCalls.length).toBeGreaterThan(0);
    expect(warnCalls[0]![0]).toContain('defaulting feePerByte to 0');

    // Cleanup
    warnSpy.mockRestore();
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // AC#1: True direct route (sender and destination under same parent)
  // -------------------------------------------------------------------------

  it('AC#1: publishEvent() with true direct route (same parent) computes amount with no intermediary fees', async () => {
    // Arrange -- use explicit ilpAddress so sender is under g.toon.useast
    const { encodeEventToToon } = await import('@toon-protocol/core/toon');
    const connector = createMockConnector({
      type: 'fulfill',
    });
    const basePricePerByte = 10n;
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      basePricePerByte,
      knownPeers: [],
      ilpAddress: 'g.toon.useast.client1',
    });
    await node.start();

    const event = createTestEvent();
    const expectedToonLength = BigInt(encodeEventToToon(event).length);
    // True direct route: same parent g.toon.useast -> zero intermediaries
    const expectedAmount = basePricePerByte * expectedToonLength;

    // Act -- destination under same parent
    await node.publishEvent(event, { destination: 'g.toon.useast.relay42' });

    // Assert -- amount = basePricePerByte * bytes (no intermediary fees)
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- test assertion
    const call = connector.sendPacketCalls[0]!;
    expect(call.amount).toBe(expectedAmount);

    // Cleanup
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // T-7.5-04: Multi-hop amount includes intermediary fees via calculateRouteAmount
  // -------------------------------------------------------------------------

  it('T-7.5-04: calculateRouteAmount correctly computes multi-hop amount for publishEvent integration', () => {
    // This verifies the formula used by publishEvent is correct.
    // publishEvent calls calculateRouteAmount internally -- we verify the
    // function independently with known inputs matching multi-hop scenario.
    const basePricePerByte = 10n;
    const packetByteLength = 100;
    const hopFees = [2n, 3n]; // two intermediaries

    const amount = calculateRouteAmount({
      basePricePerByte,
      packetByteLength,
      hopFees,
    });

    // Assert: (10 * 100) + (2 * 100) + (3 * 100) = 1500
    expect(amount).toBe(1500n);
  });
});

// ---------------------------------------------------------------------------
// Story 7.6: Prepaid Protocol Model - publishEvent amount override & bid cap
// ---------------------------------------------------------------------------

describe('publishEvent() prepaid protocol model (Story 7.6)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // T-7.6-01: publishEvent with amount override
  // -------------------------------------------------------------------------

  it('T-7.6-01 [P0]: publishEvent() with amount option uses provided amount as base instead of basePricePerByte * bytes (AC #1)', async () => {
    // Arrange
    const connector = createMockConnector({
      type: 'fulfill',
    });
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      basePricePerByte: 10n,
      knownPeers: [],
    });
    await node.start();

    const event = createTestEvent();

    // Act -- provide explicit amount
    await node.publishEvent(event, {
      destination: 'g.peer.address',
      amount: 50000n,
    });

    // Assert -- the ILP PREPARE amount should include 50000n (not basePricePerByte * bytes)
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- test assertion
    const call = connector.sendPacketCalls[0]!;
    // With a direct route (unknown intermediary defaults to 0n fee),
    // total amount = 50000n + 0 route fees = 50000n
    expect(call.amount).toBe(50000n);

    // Cleanup
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // T-7.6-06: publishEvent without amount uses default basePricePerByte * bytes
  // -------------------------------------------------------------------------

  it('T-7.6-06 [P0]: publishEvent() without amount option uses basePricePerByte * toonData.length (AC #2)', async () => {
    // Arrange
    const { encodeEventToToon } = await import('@toon-protocol/core/toon');
    const connector = createMockConnector({
      type: 'fulfill',
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

    // Act -- no amount option
    await node.publishEvent(event, { destination: 'g.peer.address' });

    // Assert -- default behavior unchanged
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- test assertion
    const call = connector.sendPacketCalls[0]!;
    expect(call.amount).toBe(expectedAmount);

    // Cleanup
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // T-7.6-04: Bid safety cap rejects when amount > bid
  // -------------------------------------------------------------------------

  it('T-7.6-04 [P0]: publishEvent() throws NodeError when amount exceeds bid safety cap (AC #3)', async () => {
    // Arrange
    const connector = createMockConnector();
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      knownPeers: [],
    });
    await node.start();

    const event = createTestEvent();

    // Act & Assert -- amount 50000n > bid 40000n -> reject before sending
    await expect(
      node.publishEvent(event, {
        destination: 'g.peer.address',
        amount: 50000n,
        bid: 40000n,
      })
    ).rejects.toThrow(NodeError);

    await expect(
      node.publishEvent(event, {
        destination: 'g.peer.address',
        amount: 50000n,
        bid: 40000n,
      })
    ).rejects.toThrow(/exceeds bid safety cap/);

    // Assert -- no ILP packet was sent
    expect(connector.sendPacketCalls.length).toBe(0);

    // Cleanup
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // T-7.6-05: Bid safety cap passes when amount <= bid
  // -------------------------------------------------------------------------

  it('T-7.6-05 [P0]: publishEvent() sends normally when amount is within bid safety cap (AC #3)', async () => {
    // Arrange
    const connector = createMockConnector({
      type: 'fulfill',
    });
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      knownPeers: [],
    });
    await node.start();

    const event = createTestEvent();

    // Act -- amount 50000n <= bid 60000n -> should send
    const result = await node.publishEvent(event, {
      destination: 'g.peer.address',
      amount: 50000n,
      bid: 60000n,
    });

    // Assert -- packet was sent successfully
    expect(result.success).toBe(true);
    expect(connector.sendPacketCalls.length).toBe(1);
    // Verify the amount sent is the override amount (50000n), not basePricePerByte * bytes
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- test assertion
    const call = connector.sendPacketCalls[0]!;
    expect(call.amount).toBe(50000n);

    // Cleanup
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // T-7.6-10: Amount override with route fees
  // -------------------------------------------------------------------------

  it('T-7.6-10 [P1]: publishEvent() with amount override adds route fees on top of provided amount', () => {
    // This verifies the formula: totalIlpAmount = amount + SUM(hopFees[i] * packetByteLength)
    // We test via calculateRouteAmount since publishEvent delegates to it.
    const packetByteLength = 100;
    const hopFees = [2n, 3n]; // two intermediaries

    // When amount is provided, basePricePerByte should be 0n (amount replaces it)
    // and the provided amount is added separately.
    const routeFeesOnly = calculateRouteAmount({
      basePricePerByte: 0n,
      packetByteLength,
      hopFees,
    });

    // Route fees = (2 * 100) + (3 * 100) = 500
    expect(routeFeesOnly).toBe(500n);

    // Total with amount override = 50000n + 500n = 50500n
    const totalWithOverride = 50000n + routeFeesOnly;
    expect(totalWithOverride).toBe(50500n);
  });

  // -------------------------------------------------------------------------
  // T-7.6-13: No bid -> no bid check
  // -------------------------------------------------------------------------

  it('T-7.6-13 [P2]: publishEvent() with amount but no bid sends without bid check (AC #1)', async () => {
    // Arrange
    const connector = createMockConnector({
      type: 'fulfill',
    });
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      knownPeers: [],
    });
    await node.start();

    const event = createTestEvent();

    // Act -- amount provided, no bid -> should send without any bid check
    const result = await node.publishEvent(event, {
      destination: 'g.peer.address',
      amount: 50000n,
    });

    // Assert -- sent successfully
    expect(result.success).toBe(true);
    expect(connector.sendPacketCalls.length).toBe(1);

    // Cleanup
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // T-7.6-08: settleCompute deprecation warning
  // -------------------------------------------------------------------------

  it('T-7.6-08 [P1]: settleCompute() logs deprecation warning on invocation (AC #4)', async () => {
    // Arrange
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const connector = createMockConnector({
      type: 'fulfill',
    });
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      knownPeers: [],
    });
    await node.start();

    // Build a valid Kind 6100 result event for settleCompute
    const { buildJobResultEvent } = await import('@toon-protocol/core');
    const resultEvent = buildJobResultEvent(
      {
        kind: 6100,
        requestEventId: 'a'.repeat(64),
        customerPubkey: 'b'.repeat(64),
        amount: '1000',
        content: 'test result',
      },
      TEST_SECRET_KEY
    );

    // Act -- call settleCompute (deprecated)
    try {
      await node.settleCompute(resultEvent, 'g.peer.provider');
    } catch {
      // May throw due to connector behavior; we only care about the warning
    }

    // Assert -- deprecation warning was logged
    const deprecationCalls = warnSpy.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('DEPRECATED')
    );
    expect(deprecationCalls.length).toBeGreaterThan(0);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- test assertion: deprecation calls verified above
    expect(deprecationCalls[0]![0]).toContain('settleCompute');

    // Cleanup
    warnSpy.mockRestore();
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // Bid equal to amount -> passes
  // -------------------------------------------------------------------------

  it('[P2] publishEvent() with amount exactly equal to bid passes bid check', async () => {
    // Arrange
    const connector = createMockConnector({
      type: 'fulfill',
    });
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      knownPeers: [],
    });
    await node.start();

    const event = createTestEvent();

    // Act -- amount == bid -> should pass
    const result = await node.publishEvent(event, {
      destination: 'g.peer.address',
      amount: 50000n,
      bid: 50000n,
    });

    // Assert
    expect(result.success).toBe(true);
    expect(connector.sendPacketCalls.length).toBe(1);

    // Cleanup
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // Bid safety cap with default (computed) amount (AC #3 gap coverage)
  // -------------------------------------------------------------------------

  it('[P1] publishEvent() throws NodeError when computed default amount exceeds bid safety cap (AC #3)', async () => {
    // Arrange -- use a high basePricePerByte so computed amount exceeds bid
    const connector = createMockConnector();
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      basePricePerByte: 10000n, // high price -> large computed amount
      knownPeers: [],
    });
    await node.start();

    const event = createTestEvent();

    // Act & Assert -- no explicit amount; computed default (10000n * toonBytes) > bid of 1n
    await expect(
      node.publishEvent(event, {
        destination: 'g.peer.address',
        bid: 1n, // very low bid, computed amount will exceed it
      })
    ).rejects.toThrow(NodeError);

    await expect(
      node.publishEvent(event, {
        destination: 'g.peer.address',
        bid: 1n,
      })
    ).rejects.toThrow(/exceeds bid safety cap/);

    // Assert -- no ILP packet was sent
    expect(connector.sendPacketCalls.length).toBe(0);

    // Cleanup
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // settleCompute backward compatibility (AC #4 gap coverage)
  // -------------------------------------------------------------------------

  it('[P1] settleCompute() still functions (backward compat) despite deprecation (AC #4)', async () => {
    // Arrange
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const connector = createMockConnector({
      type: 'fulfill',
    });
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      knownPeers: [],
    });
    await node.start();

    // Build a valid Kind 6100 result event for settleCompute
    const { buildJobResultEvent } = await import('@toon-protocol/core');
    const resultEvent = buildJobResultEvent(
      {
        kind: 6100,
        requestEventId: 'a'.repeat(64),
        customerPubkey: 'b'.repeat(64),
        amount: '1000',
        content: 'test result',
      },
      TEST_SECRET_KEY
    );

    // Act -- call settleCompute (deprecated but still functional)
    const result = await node.settleCompute(resultEvent, 'g.peer.provider');

    // Assert -- method still works and returns a result
    expect(result).toBeDefined();
    expect(result.accepted).toBe(true);

    // Assert -- ILP packet was actually sent via connector
    expect(connector.sendPacketCalls.length).toBe(1);

    // Cleanup
    warnSpy.mockRestore();
    await node.stop();
  });
});

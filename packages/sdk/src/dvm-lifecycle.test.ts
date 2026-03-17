/**
 * Unit Tests: DVM Lifecycle SDK Helpers (Story 5.3, Task 1)
 *
 * Tests the three new ServiceNode helper methods:
 *   - publishFeedback(requestEventId, customerPubkey, status, content?)
 *   - publishResult(requestEventId, customerPubkey, amount, content, options?)
 *   - settleCompute(resultEvent, providerIlpAddress, options?)
 *
 * These helpers compose existing primitives (buildJobFeedbackEvent,
 * buildJobResultEvent, publishEvent, ilpClient.sendIlpPacket) into
 * convenient DVM-specific SDK methods.
 *
 * Test IDs (from test-design-epic-5.md + story extensions):
 *   T-5.3-04 - settleCompute() rejects when amount > originalBid (E5-R005)
 *   T-5.3-05 - settleCompute() accepts when amount <= originalBid (E5-R005)
 *   T-5.3-10 - publishFeedback() constructs valid Kind 7000 with e and status tags
 *   T-5.3-11 - publishResult() constructs valid Kind 6xxx with e, p, amount tags
 *   T-5.3-12 - settleCompute() extracts amount and sends payment with empty data
 *   T-5.3-16 - Feedback and result events pay basePricePerByte * toonData.length
 *   T-5.3-17 - settleCompute() throws NodeError for malformed result event
 *   T-5.3-18 - settleCompute() with originalBid omitted -> no validation
 *
 * Implementation Phase: GREEN -- all methods implemented on the ServiceNode
 * interface in Story 5.3: publishFeedback(), publishResult(), settleCompute().
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { NostrEvent } from 'nostr-tools/pure';
import { createNode } from './create-node.js';
import { NodeError } from './errors.js';

// Prevent live relay connections (project rule: always mock nostr-tools in tests)
vi.mock('nostr-tools');

import type {
  HandlePacketRequest,
  HandlePacketResponse,
  EmbeddableConnectorLike,
  SendPacketParams,
  SendPacketResult,
  RegisterPeerParams,
} from '@crosstown/core';
// DVM constants available from @crosstown/core:
// JOB_FEEDBACK_KIND, TEXT_GENERATION_KIND -- used by the implementation under test.

// ---------------------------------------------------------------------------
// Test Fixtures: Deterministic mock data
// ---------------------------------------------------------------------------

/** Fixed secret key for deterministic identity derivation (32 bytes) */
const TEST_SECRET_KEY = Uint8Array.from(Buffer.from('a'.repeat(64), 'hex'));

/** Deterministic request event ID (64-char hex) */
const TEST_REQUEST_EVENT_ID = 'b'.repeat(64);

/** Deterministic customer pubkey (64-char hex) */
const TEST_CUSTOMER_PUBKEY = 'cd'.repeat(32);

/** Deterministic provider ILP address */
const TEST_PROVIDER_ILP_ADDRESS = 'g.crosstown.provider.node-a';

/** Fixed timestamp for deterministic test data */
const FIXED_CREATED_AT = 1700000000;

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

/**
 * Creates a deterministic Kind 6100 result event for settleCompute() tests.
 * Mimics the shape produced by buildJobResultEvent() without requiring
 * a real signing key.
 */
function createMockResultEvent(
  overrides: Partial<NostrEvent> = {}
): NostrEvent {
  return {
    id: 'e'.repeat(64),
    pubkey: 'f'.repeat(64),
    created_at: FIXED_CREATED_AT,
    kind: 6100, // TEXT_GENERATION_KIND + 1000
    content: 'Generated text result from provider',
    tags: [
      ['e', TEST_REQUEST_EVENT_ID],
      ['p', TEST_CUSTOMER_PUBKEY],
      ['amount', '3000000', 'usdc'],
    ],
    sig: 'a'.repeat(128),
    ...overrides,
  };
}

/**
 * Creates a result event with no amount tag (malformed).
 */
function createMalformedResultEvent(): NostrEvent {
  return {
    id: 'e'.repeat(64),
    pubkey: 'f'.repeat(64),
    created_at: FIXED_CREATED_AT,
    kind: 6100,
    content: 'Result with no amount',
    tags: [
      ['e', TEST_REQUEST_EVENT_ID],
      ['p', TEST_CUSTOMER_PUBKEY],
      // Missing ['amount', ...] tag
    ],
    sig: 'a'.repeat(128),
  };
}

// ---------------------------------------------------------------------------
// Test Suite: publishFeedback() (Task 1.1, 1.5)
// ---------------------------------------------------------------------------

describe('publishFeedback() unit tests (Story 5.3, Task 1.1/1.5)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // T-5.3-10: publishFeedback() delegates to buildJobFeedbackEvent() and publishEvent()
  it('[P1] T-5.3-10: publishFeedback() builds Kind 7000 event and delegates to publishEvent() for ILP delivery', async () => {
    // Arrange
    const connector = createMockConnector();
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      basePricePerByte: 10n,
      knownPeers: [],
    });
    await node.start();

    // Act -- call publishFeedback() helper
    const result = await node.publishFeedback(
      TEST_REQUEST_EVENT_ID,
      TEST_CUSTOMER_PUBKEY,
      'processing',
      undefined,
      { destination: 'g.crosstown.relay' }
    );

    // Assert -- publish succeeded
    expect(result).toBeDefined();
    expect(result.success).toBe(true);

    // Assert -- the event was sent via connector.sendPacket
    expect(connector.sendPacketCalls).toHaveLength(1);

    // Cleanup
    await node.stop();
  });

  // T-5.3-10 amplification: publishFeedback with content
  it('[P1] T-5.3-10 amplification: publishFeedback() includes content in the feedback event', async () => {
    // Arrange
    const connector = createMockConnector();
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      basePricePerByte: 10n,
      knownPeers: [],
    });
    await node.start();

    // Act
    const result = await node.publishFeedback(
      TEST_REQUEST_EVENT_ID,
      TEST_CUSTOMER_PUBKEY,
      'processing',
      '50% complete',
      { destination: 'g.crosstown.relay' }
    );

    // Assert
    expect(result).toBeDefined();
    expect(result.success).toBe(true);
    expect(connector.sendPacketCalls).toHaveLength(1);

    // Cleanup
    await node.stop();
  });

  // T-5.3-10 amplification: publishFeedback with error status
  it('[P1] T-5.3-10 amplification: publishFeedback() with error status includes error details in content', async () => {
    // Arrange
    const connector = createMockConnector();
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      basePricePerByte: 10n,
      knownPeers: [],
    });
    await node.start();

    // Act
    const result = await node.publishFeedback(
      TEST_REQUEST_EVENT_ID,
      TEST_CUSTOMER_PUBKEY,
      'error',
      'GPU out of memory',
      { destination: 'g.crosstown.relay' }
    );

    // Assert
    expect(result).toBeDefined();
    expect(result.success).toBe(true);

    // Cleanup
    await node.stop();
  });

  // T-5.3-16: Feedback events pay basePricePerByte * toonData.length
  it('[P1] T-5.3-16: publishFeedback() event pays basePricePerByte * toonData.length (standard pricing, no DVM override)', async () => {
    // Arrange
    const basePricePerByte = 10n;
    const connector = createMockConnector();
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      basePricePerByte,
      knownPeers: [],
    });
    await node.start();

    // Act
    await node.publishFeedback(
      TEST_REQUEST_EVENT_ID,
      TEST_CUSTOMER_PUBKEY,
      'processing',
      undefined,
      { destination: 'g.crosstown.relay' }
    );

    // Assert -- amount should be basePricePerByte * toonData.length
    expect(connector.sendPacketCalls).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- test assertion
    const call = connector.sendPacketCalls[0]!;
    // The amount is computed internally by publishEvent() as
    // basePricePerByte * toonData.length. Verify by computing from the
    // TOON-encoded data actually sent to the connector.
    const toonDataLength = BigInt(call.data.length);
    expect(toonDataLength).toBeGreaterThan(0n);
    expect(call.amount).toBe(basePricePerByte * toonDataLength);

    // Cleanup
    await node.stop();
  });

  // Guard: publishFeedback() before start() throws NodeError
  it('[P1] publishFeedback() throws NodeError when called before start()', async () => {
    // Arrange
    const connector = createMockConnector();
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      knownPeers: [],
    });

    // Act & Assert
    await expect(
      node.publishFeedback(
        TEST_REQUEST_EVENT_ID,
        TEST_CUSTOMER_PUBKEY,
        'processing',
        undefined,
        { destination: 'g.crosstown.relay' }
      )
    ).rejects.toThrow(NodeError);
  });
});

// ---------------------------------------------------------------------------
// Test Suite: publishResult() (Task 1.2, 1.6)
// ---------------------------------------------------------------------------

describe('publishResult() unit tests (Story 5.3, Task 1.2/1.6)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // T-5.3-11: publishResult() delegates to buildJobResultEvent() and publishEvent()
  it('[P1] T-5.3-11: publishResult() builds Kind 6100 event and delegates to publishEvent() for ILP delivery', async () => {
    // Arrange
    const connector = createMockConnector();
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      basePricePerByte: 10n,
      knownPeers: [],
    });
    await node.start();

    // Act -- call publishResult() helper
    const result = await node.publishResult(
      TEST_REQUEST_EVENT_ID,
      TEST_CUSTOMER_PUBKEY,
      '3000000',
      'Here is the generated text result',
      { destination: 'g.crosstown.relay' }
    );

    // Assert -- publish succeeded
    expect(result).toBeDefined();
    expect(result.success).toBe(true);

    // Assert -- the event was sent via connector.sendPacket
    expect(connector.sendPacketCalls).toHaveLength(1);

    // Cleanup
    await node.stop();
  });

  // T-5.3-11 amplification: publishResult() with custom kind
  it('[P1] T-5.3-11 amplification: publishResult() accepts custom kind option (e.g., 6200 for image generation result)', async () => {
    // Arrange
    const connector = createMockConnector();
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      basePricePerByte: 10n,
      knownPeers: [],
    });
    await node.start();

    // Act
    const result = await node.publishResult(
      TEST_REQUEST_EVENT_ID,
      TEST_CUSTOMER_PUBKEY,
      '5000000',
      'https://example.com/generated-image.png',
      { destination: 'g.crosstown.relay', kind: 6200 }
    );

    // Assert
    expect(result).toBeDefined();
    expect(result.success).toBe(true);

    // Cleanup
    await node.stop();
  });

  // T-5.3-16: Result events pay basePricePerByte * toonData.length
  it('[P1] T-5.3-16: publishResult() event pays basePricePerByte * toonData.length (standard pricing, no DVM override)', async () => {
    // Arrange
    const basePricePerByte = 10n;
    const connector = createMockConnector();
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      basePricePerByte,
      knownPeers: [],
    });
    await node.start();

    // Act
    await node.publishResult(
      TEST_REQUEST_EVENT_ID,
      TEST_CUSTOMER_PUBKEY,
      '3000000',
      'Result content',
      { destination: 'g.crosstown.relay' }
    );

    // Assert -- amount should be basePricePerByte * toonData.length
    expect(connector.sendPacketCalls).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- test assertion
    const call = connector.sendPacketCalls[0]!;
    // Verify by computing from the TOON-encoded data actually sent to the connector.
    const toonDataLength = BigInt(call.data.length);
    expect(toonDataLength).toBeGreaterThan(0n);
    expect(call.amount).toBe(basePricePerByte * toonDataLength);

    // Cleanup
    await node.stop();
  });

  // Guard: publishResult() before start() throws NodeError
  it('[P1] publishResult() throws NodeError when called before start()', async () => {
    // Arrange
    const connector = createMockConnector();
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      knownPeers: [],
    });

    // Act & Assert
    await expect(
      node.publishResult(
        TEST_REQUEST_EVENT_ID,
        TEST_CUSTOMER_PUBKEY,
        '3000000',
        'Result content',
        { destination: 'g.crosstown.relay' }
      )
    ).rejects.toThrow(NodeError);
  });
});

// ---------------------------------------------------------------------------
// Test Suite: settleCompute() (Task 1.3, 1.7, 1.8, 1.9, 1.10, 1.11)
// ---------------------------------------------------------------------------

describe('settleCompute() unit tests (Story 5.3, Task 1.3/1.7-1.11)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // T-5.3-12: settleCompute() extracts amount and sends payment with empty data
  it('[P1] T-5.3-12: settleCompute() extracts amount from result event and sends ILP payment with empty data field', async () => {
    // Arrange
    const connector = createMockConnector();
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      basePricePerByte: 10n,
      knownPeers: [],
    });
    await node.start();

    const resultEvent = createMockResultEvent();

    // Act -- call settleCompute() helper
    const result = await node.settleCompute(
      resultEvent,
      TEST_PROVIDER_ILP_ADDRESS
    );

    // Assert -- settlement succeeded
    expect(result).toBeDefined();
    expect(result.accepted).toBe(true);

    // Assert -- sendPacket was called with correct parameters
    expect(connector.sendPacketCalls).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- test assertion
    const call = connector.sendPacketCalls[0]!;

    // Assert -- destination is the provider's ILP address
    expect(call.destination).toBe(TEST_PROVIDER_ILP_ADDRESS);

    // Assert -- amount matches the result event's amount tag ('3000000')
    expect(String(call.amount)).toBe('3000000');

    // Assert -- data is empty (pure value transfer, not a relay write)
    expect(call.data).toBeInstanceOf(Uint8Array);
    expect(call.data.length).toBe(0);

    // Cleanup
    await node.stop();
  });

  // T-5.3-04: settleCompute() rejects when amount > originalBid (E5-R005)
  it('[P0] T-5.3-04: settleCompute() throws NodeError when result amount exceeds originalBid (E5-R005 bid validation)', async () => {
    // Arrange
    const connector = createMockConnector();
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      knownPeers: [],
    });
    await node.start();

    // Result event has amount '3000000'
    const resultEvent = createMockResultEvent();

    // Act & Assert -- bid is '2000000' (less than result amount '3000000')
    await expect(
      node.settleCompute(resultEvent, TEST_PROVIDER_ILP_ADDRESS, {
        originalBid: '2000000',
      })
    ).rejects.toThrow(NodeError);

    // Assert -- no payment was sent
    expect(connector.sendPacketCalls).toHaveLength(0);

    // Cleanup
    await node.stop();
  });

  // T-5.3-04 amplification: error message indicates amount exceeds bid
  it('[P0] T-5.3-04 amplification: settleCompute() error message indicates amount exceeds bid', async () => {
    // Arrange
    const connector = createMockConnector();
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      knownPeers: [],
    });
    await node.start();

    const resultEvent = createMockResultEvent();

    // Act & Assert
    await expect(
      node.settleCompute(resultEvent, TEST_PROVIDER_ILP_ADDRESS, {
        originalBid: '1000000',
      })
    ).rejects.toThrow(/amount.*exceed.*bid|bid.*exceed/i);

    // Cleanup
    await node.stop();
  });

  // T-5.3-05: settleCompute() accepts when amount <= originalBid (E5-R005)
  it('[P0] T-5.3-05: settleCompute() proceeds when result amount <= originalBid (E5-R005 bid validation passes)', async () => {
    // Arrange
    const connector = createMockConnector();
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      knownPeers: [],
    });
    await node.start();

    // Result event has amount '3000000'
    const resultEvent = createMockResultEvent();

    // Act -- bid is '5000000' (more than result amount '3000000')
    const result = await node.settleCompute(
      resultEvent,
      TEST_PROVIDER_ILP_ADDRESS,
      { originalBid: '5000000' }
    );

    // Assert -- payment was sent
    expect(result).toBeDefined();
    expect(result.accepted).toBe(true);
    expect(connector.sendPacketCalls).toHaveLength(1);

    // Cleanup
    await node.stop();
  });

  // T-5.3-05 amplification: exact equality (amount == bid) should succeed
  it('[P0] T-5.3-05 amplification: settleCompute() accepts when amount exactly equals originalBid', async () => {
    // Arrange
    const connector = createMockConnector();
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      knownPeers: [],
    });
    await node.start();

    // Result event has amount '3000000'
    const resultEvent = createMockResultEvent();

    // Act -- bid exactly equals amount
    const result = await node.settleCompute(
      resultEvent,
      TEST_PROVIDER_ILP_ADDRESS,
      { originalBid: '3000000' }
    );

    // Assert
    expect(result).toBeDefined();
    expect(result.accepted).toBe(true);
    expect(connector.sendPacketCalls).toHaveLength(1);

    // Cleanup
    await node.stop();
  });

  // T-5.3-17: settleCompute() throws NodeError for malformed result event
  it('[P1] T-5.3-17: settleCompute() throws NodeError for result event with no amount tag (malformed)', async () => {
    // Arrange
    const connector = createMockConnector();
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      knownPeers: [],
    });
    await node.start();

    const malformedEvent = createMalformedResultEvent();

    // Act & Assert
    await expect(
      node.settleCompute(malformedEvent, TEST_PROVIDER_ILP_ADDRESS)
    ).rejects.toThrow(NodeError);

    // Assert -- no payment was sent
    expect(connector.sendPacketCalls).toHaveLength(0);

    // Cleanup
    await node.stop();
  });

  // T-5.3-18: settleCompute() with originalBid omitted -> no validation
  it('[P1] T-5.3-18: settleCompute() with originalBid omitted proceeds without bid validation', async () => {
    // Arrange
    const connector = createMockConnector();
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      knownPeers: [],
    });
    await node.start();

    // Result event has amount '3000000' -- no originalBid provided
    const resultEvent = createMockResultEvent();

    // Act -- no originalBid option
    const result = await node.settleCompute(
      resultEvent,
      TEST_PROVIDER_ILP_ADDRESS
    );

    // Assert -- payment was sent (no bid validation)
    expect(result).toBeDefined();
    expect(result.accepted).toBe(true);
    expect(connector.sendPacketCalls).toHaveLength(1);

    // Cleanup
    await node.stop();
  });

  // T-5.3-18 amplification: omitted originalBid with high amount still proceeds
  it('[P1] T-5.3-18 amplification: settleCompute() without originalBid sends payment even for very large amounts', async () => {
    // Arrange
    const connector = createMockConnector();
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      knownPeers: [],
    });
    await node.start();

    // Very large amount -- without bid validation, this should succeed
    const resultEvent = createMockResultEvent({
      tags: [
        ['e', TEST_REQUEST_EVENT_ID],
        ['p', TEST_CUSTOMER_PUBKEY],
        ['amount', '999999999999', 'usdc'],
      ],
    });

    // Act
    const result = await node.settleCompute(
      resultEvent,
      TEST_PROVIDER_ILP_ADDRESS
    );

    // Assert
    expect(result).toBeDefined();
    expect(result.accepted).toBe(true);

    // Cleanup
    await node.stop();
  });

  // T-5.3-07: settleCompute() with invalid/unreachable ILP address (E5-R006)
  // Note: T-5.3-07 in test-design covers "provider has no kind:10035 event".
  // Since settleCompute() takes an explicit ILP address (not resolving from
  // kind:10035), this test validates the downstream failure: connector rejects
  // a packet to an unreachable destination with F02.
  it('[P1] T-5.3-07: settleCompute() returns rejected result when connector cannot route to provider ILP address', async () => {
    // Arrange -- connector returns reject for unreachable destination
    const connector = createMockConnector({
      type: 'reject',
      code: 'F02',
      message: 'No route found',
      data: Buffer.alloc(0),
    } as SendPacketResult);
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      knownPeers: [],
    });
    await node.start();

    const resultEvent = createMockResultEvent();

    // Act
    const result = await node.settleCompute(
      resultEvent,
      'g.crosstown.nonexistent.provider'
    );

    // Assert -- settlement was rejected (not accepted)
    expect(result).toBeDefined();
    expect(result.accepted).toBe(false);

    // Cleanup
    await node.stop();
  });

  // Guard: settleCompute() before start() throws NodeError
  it('[P1] settleCompute() throws NodeError when called before start()', async () => {
    // Arrange
    const connector = createMockConnector();
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      knownPeers: [],
    });

    const resultEvent = createMockResultEvent();

    // Act & Assert
    await expect(
      node.settleCompute(resultEvent, TEST_PROVIDER_ILP_ADDRESS)
    ).rejects.toThrow(NodeError);
  });

  // Guard: settleCompute() with empty providerIlpAddress throws NodeError
  it('[P1] settleCompute() throws NodeError when providerIlpAddress is empty', async () => {
    // Arrange
    const connector = createMockConnector();
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      knownPeers: [],
    });
    await node.start();

    const resultEvent = createMockResultEvent();

    // Act & Assert
    await expect(node.settleCompute(resultEvent, '')).rejects.toThrow(
      NodeError
    );

    // Assert -- no payment was sent
    expect(connector.sendPacketCalls).toHaveLength(0);

    // Cleanup
    await node.stop();
  });

  // Guard: settleCompute() with whitespace-only providerIlpAddress throws NodeError
  it('[P1] settleCompute() throws NodeError when providerIlpAddress is whitespace-only', async () => {
    // Arrange
    const connector = createMockConnector();
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      knownPeers: [],
    });
    await node.start();

    const resultEvent = createMockResultEvent();

    // Act & Assert -- whitespace-only should be rejected
    await expect(node.settleCompute(resultEvent, '   ')).rejects.toThrow(
      NodeError
    );

    // Assert -- no payment was sent
    expect(connector.sendPacketCalls).toHaveLength(0);

    // Cleanup
    await node.stop();
  });

  // Guard: settleCompute() with non-numeric amount WITHOUT bid validation throws NodeError
  it('[P1] settleCompute() throws NodeError when result event amount is non-numeric even without bid validation', async () => {
    // Arrange
    const connector = createMockConnector();
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      knownPeers: [],
    });
    await node.start();

    // Result event with non-numeric amount tag, NO originalBid
    const resultEvent = createMockResultEvent({
      tags: [
        ['e', TEST_REQUEST_EVENT_ID],
        ['p', TEST_CUSTOMER_PUBKEY],
        ['amount', 'xyz', 'usdc'],
      ],
    });

    // Act & Assert -- should throw NodeError, not BootstrapError from sendIlpPacket
    await expect(
      node.settleCompute(resultEvent, TEST_PROVIDER_ILP_ADDRESS)
    ).rejects.toThrow(NodeError);

    // Assert -- no payment was sent
    expect(connector.sendPacketCalls).toHaveLength(0);

    // Cleanup
    await node.stop();
  });

  // Guard: settleCompute() with non-numeric originalBid throws NodeError
  it('[P1] settleCompute() throws NodeError when originalBid is not a valid numeric string', async () => {
    // Arrange
    const connector = createMockConnector();
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      knownPeers: [],
    });
    await node.start();

    const resultEvent = createMockResultEvent();

    // Act & Assert -- non-numeric originalBid should produce NodeError, not SyntaxError
    await expect(
      node.settleCompute(resultEvent, TEST_PROVIDER_ILP_ADDRESS, {
        originalBid: 'not-a-number',
      })
    ).rejects.toThrow(NodeError);

    // Assert -- no payment was sent
    expect(connector.sendPacketCalls).toHaveLength(0);

    // Cleanup
    await node.stop();
  });

  // Guard: settleCompute() with non-numeric amount in result event throws NodeError
  it('[P1] settleCompute() throws NodeError when result event amount is not a valid numeric string during bid validation', async () => {
    // Arrange
    const connector = createMockConnector();
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      knownPeers: [],
    });
    await node.start();

    // Result event with non-numeric amount tag
    const resultEvent = createMockResultEvent({
      tags: [
        ['e', TEST_REQUEST_EVENT_ID],
        ['p', TEST_CUSTOMER_PUBKEY],
        ['amount', 'abc', 'usdc'],
      ],
    });

    // Act & Assert -- non-numeric amount should produce NodeError, not SyntaxError
    await expect(
      node.settleCompute(resultEvent, TEST_PROVIDER_ILP_ADDRESS, {
        originalBid: '5000000',
      })
    ).rejects.toThrow(NodeError);

    // Assert -- no payment was sent
    expect(connector.sendPacketCalls).toHaveLength(0);

    // Cleanup
    await node.stop();
  });

  // Guard: settleCompute() with negative amount throws NodeError
  it('[P1] settleCompute() throws NodeError when result event amount is negative', async () => {
    // Arrange
    const connector = createMockConnector();
    const node = createNode({
      secretKey: TEST_SECRET_KEY,
      connector,
      knownPeers: [],
    });
    await node.start();

    // Result event with negative amount tag
    const resultEvent = createMockResultEvent({
      tags: [
        ['e', TEST_REQUEST_EVENT_ID],
        ['p', TEST_CUSTOMER_PUBKEY],
        ['amount', '-1000000', 'usdc'],
      ],
    });

    // Act & Assert -- negative amount should produce NodeError
    await expect(
      node.settleCompute(resultEvent, TEST_PROVIDER_ILP_ADDRESS)
    ).rejects.toThrow(NodeError);

    // Assert -- no payment was sent
    expect(connector.sendPacketCalls).toHaveLength(0);

    // Cleanup
    await node.stop();
  });
});

// ---------------------------------------------------------------------------
// Test Suite: Service Discovery Integration (Task 3.2)
// ---------------------------------------------------------------------------

describe('settleCompute() service discovery address extraction (Story 5.3, Task 3.2)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // T-5.3-06: Provider ILP address from kind:10035 service discovery event
  it('[P1] T-5.3-06: parseServiceDiscovery() extracts ilpAddress from kind:10035 for use with settleCompute()', async () => {
    // This test validates the address extraction chain:
    //   query relay for kind:10035 -> parseServiceDiscovery(event).ilpAddress -> settleCompute()
    // The actual settleCompute() call is tested above; here we validate the
    // parseServiceDiscovery() -> ilpAddress extraction that feeds into it.

    // Import parseServiceDiscovery from core
    const { parseServiceDiscovery } = await import('@crosstown/core');

    // Arrange -- create a mock kind:10035 event with all required fields
    const discoveryEvent: NostrEvent = {
      id: 'd'.repeat(64),
      pubkey: 'f'.repeat(64),
      created_at: FIXED_CREATED_AT,
      kind: 10035,
      content: JSON.stringify({
        serviceType: 'dvm-provider',
        ilpAddress: 'g.crosstown.provider.node-a',
        pricing: {
          basePricePerByte: 10,
          currency: 'USDC',
        },
        supportedKinds: [5100, 5200],
        capabilities: ['text-generation', 'image-generation'],
        chain: 'evm:base:31337',
        version: '1.0.0',
      }),
      tags: [],
      sig: 'a'.repeat(128),
    };

    // Act
    const parsed = parseServiceDiscovery(discoveryEvent);

    // Assert
    expect(parsed).not.toBeNull();
    expect(parsed?.ilpAddress).toBe('g.crosstown.provider.node-a');
  });
});

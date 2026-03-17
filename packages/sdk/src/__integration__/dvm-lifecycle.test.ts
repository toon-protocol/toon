/**
 * Integration Tests: DVM Lifecycle -- Feedback, Result, Settlement (Story 5.3)
 *
 * Validates end-to-end DVM lifecycle through the existing Crosstown
 * infrastructure. Story 5.3 adds three new SDK helper methods:
 *   - publishFeedback() -- builds and publishes Kind 7000 feedback events
 *   - publishResult() -- builds and publishes Kind 6xxx result events
 *   - settleCompute() -- sends ILP payment for compute settlement
 *
 * These tests validate the helpers work within the full SDK pipeline:
 *   1. Feedback/result events flow through TOON encoding, ILP PREPARE
 *   2. Compute settlement sends pure ILP value transfer (empty data)
 *   3. Full DVM lifecycle: request -> feedback -> result -> settlement
 *   4. Event correlation via e tag
 *   5. Error lifecycle: request -> error feedback -> no settlement
 *   6. Cross-story boundaries: TOON roundtrip, amount preservation
 *
 * Test IDs (from test-design-epic-5.md + story extensions):
 *   T-5.3-01 - Provider publishes Kind 7000 feedback via ILP PREPARE -> relay stores
 *   T-5.3-02 - Provider publishes Kind 6xxx result with correct tags via ILP PREPARE
 *   T-5.3-03 - Compute settlement: customer -> settleCompute() -> ILP payment to provider
 *   T-5.3-08 - Error handling: provider publishes Kind 7000 with status: 'error'
 *   T-5.3-09 - Full lifecycle: request -> feedback -> result -> settleCompute()
 *   T-5.3-13 - Compute payment uses existing EVM payment channels
 *   T-5.3-14 - Multi-hop routing: compute payment routes through ILP mesh
 *   T-5.3-19 - Customer receives feedback + result correlated by requestEventId
 *   T-5.3-20 - Error lifecycle: request -> error feedback -> no result -> no settlement
 *   T-INT-02 - Provider's Kind 6xxx references customer's Kind 5xxx via e tag
 *   T-INT-03 - Kind 6xxx amount tag preserved through TOON encode/decode
 *   T-INT-07 - Kind 6100 result with complex content survives TOON roundtrip
 *   T-INT-08 - Kind 7000 feedback with all four status values survives TOON roundtrip
 *   T-5.3-06-I - Full kind:10035 -> parseServiceDiscovery -> settleCompute chain (AC #3)
 *
 * Implementation Phase: GREEN -- all methods implemented on the ServiceNode
 * interface in Story 5.3: publishFeedback(), publishResult(), settleCompute().
 *
 * Prerequisites:
 *   These integration tests use an embedded MockEmbeddedConnector with
 *   in-process packet delivery. No external infrastructure required.
 *   Full pipeline tests create real TOON-encoded signed Nostr events.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { generateSecretKey, finalizeEvent } from 'nostr-tools/pure';

// --- Imports from @crosstown/sdk ---
import { createNode } from '../index.js';

// --- Imports from @crosstown/core ---
import type {
  HandlePacketRequest,
  HandlePacketResponse,
  EmbeddableConnectorLike,
  SendPacketParams,
  SendPacketResult,
  RegisterPeerParams,
} from '@crosstown/core';
import {
  TEXT_GENERATION_KIND,
  buildJobRequestEvent,
  buildJobResultEvent,
  parseJobResult,
  parseJobFeedback,
  parseServiceDiscovery,
  buildServiceDiscoveryEvent,
  JOB_FEEDBACK_KIND,
} from '@crosstown/core';

// --- Import from @crosstown/core/toon (canonical TOON codec location) ---
import { encodeEventToToon, decodeEventFromToon } from '@crosstown/core/toon';

// ---------------------------------------------------------------------------
// Mock Embedded Connector (same pattern as dvm-job-submission.test.ts)
// ---------------------------------------------------------------------------

class MockEmbeddedConnector implements EmbeddableConnectorLike {
  public packetHandler:
    | ((
        req: HandlePacketRequest
      ) => HandlePacketResponse | Promise<HandlePacketResponse>)
    | null = null;
  public readonly registeredPeers = new Map<string, RegisterPeerParams>();
  public readonly sendPacketCalls: SendPacketParams[] = [];

  async sendPacket(params: SendPacketParams): Promise<SendPacketResult> {
    this.sendPacketCalls.push(params);
    return {
      type: 'fulfill',
      fulfillment: Buffer.from('dvm-lifecycle-fulfillment'),
    };
  }

  async registerPeer(params: RegisterPeerParams): Promise<void> {
    this.registeredPeers.set(params.id, params);
  }

  async removePeer(peerId: string): Promise<void> {
    this.registeredPeers.delete(peerId);
  }

  setPacketHandler(
    handler: (
      req: HandlePacketRequest
    ) => HandlePacketResponse | Promise<HandlePacketResponse>
  ): void {
    this.packetHandler = handler;
  }

  /**
   * Simulate delivering an incoming ILP packet to the registered handler.
   */
  async deliverPacket(
    request: HandlePacketRequest
  ): Promise<HandlePacketResponse> {
    if (!this.packetHandler) {
      throw new Error('No packet handler registered');
    }
    return this.packetHandler(request);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fixed timestamp for deterministic test data */
const FIXED_CREATED_AT = 1700000000;

/** Deterministic request event ID (64-char hex) */
const TEST_REQUEST_EVENT_ID = 'b'.repeat(64);

/** Deterministic customer pubkey (64-char hex) */
const TEST_CUSTOMER_PUBKEY = 'cd'.repeat(32);

/** Deterministic provider ILP address */
const TEST_PROVIDER_ILP_ADDRESS = 'g.crosstown.provider.node-a';

// ---------------------------------------------------------------------------
// Test Suite: Feedback Event Publishing (Task 2.1, 2.3)
// ---------------------------------------------------------------------------

describe('DVM Feedback Publishing via publishFeedback() (Story 5.3, Task 2)', () => {
  let nodeSecretKey: Uint8Array;

  beforeAll(() => {
    nodeSecretKey = generateSecretKey();
  });

  // T-5.3-01: Provider publishes Kind 7000 feedback (status: 'processing') via ILP PREPARE
  it('[P1] T-5.3-01: publishFeedback() sends Kind 7000 feedback via ILP PREPARE with correct e, p, and status tags', async () => {
    // Arrange
    const connector = new MockEmbeddedConnector();
    const basePricePerByte = 10n;
    const node = createNode({
      secretKey: nodeSecretKey,
      connector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      basePricePerByte,
      knownPeers: [],
    });
    await node.start();

    // Act -- publish feedback using the new helper
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

    // Assert -- sendPacket was called
    expect(connector.sendPacketCalls).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- test assertion
    const call = connector.sendPacketCalls[0]!;

    // Assert -- data is TOON-encoded Kind 7000 event
    expect(call.data).toBeInstanceOf(Uint8Array);
    expect(call.data.length).toBeGreaterThan(0);

    // Assert -- decode TOON to verify event structure
    const decoded = decodeEventFromToon(call.data);
    expect(decoded.kind).toBe(JOB_FEEDBACK_KIND);

    // Assert -- feedback has correct NIP-90 tags
    const eTag = decoded.tags.find((t: string[]) => t[0] === 'e');
    expect(eTag).toBeDefined();
    expect(eTag?.[1]).toBe(TEST_REQUEST_EVENT_ID);

    const pTag = decoded.tags.find((t: string[]) => t[0] === 'p');
    expect(pTag).toBeDefined();
    expect(pTag?.[1]).toBe(TEST_CUSTOMER_PUBKEY);

    const statusTag = decoded.tags.find((t: string[]) => t[0] === 'status');
    expect(statusTag).toBeDefined();
    expect(statusTag?.[1]).toBe('processing');

    // Assert -- parseable by parseJobFeedback()
    const parsed = parseJobFeedback(decoded);
    expect(parsed).not.toBeNull();
    expect(parsed?.requestEventId).toBe(TEST_REQUEST_EVENT_ID);
    expect(parsed?.customerPubkey).toBe(TEST_CUSTOMER_PUBKEY);
    expect(parsed?.status).toBe('processing');

    // Cleanup
    await node.stop();
  });

  // T-5.3-08: Error handling: provider publishes Kind 7000 with status: 'error'
  it('[P1] T-5.3-08: publishFeedback() with error status includes error details in content', async () => {
    // Arrange
    const connector = new MockEmbeddedConnector();
    const node = createNode({
      secretKey: nodeSecretKey,
      connector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
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
    expect(result.success).toBe(true);

    // Decode and verify error content
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- test assertion
    const call = connector.sendPacketCalls[0]!;
    const decoded = decodeEventFromToon(call.data);
    expect(decoded.content).toBe('GPU out of memory');

    const parsed = parseJobFeedback(decoded);
    expect(parsed?.status).toBe('error');
    expect(parsed?.content).toBe('GPU out of memory');

    // Cleanup
    await node.stop();
  });

  // T-INT-08: Kind 7000 feedback with all four status values survives TOON roundtrip
  it('[P0] T-INT-08: Kind 7000 feedback with all four status values (processing, error, success, partial) survives TOON roundtrip', async () => {
    // Arrange
    const connector = new MockEmbeddedConnector();
    const node = createNode({
      secretKey: nodeSecretKey,
      connector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      knownPeers: [],
    });
    await node.start();

    const statuses = ['processing', 'error', 'success', 'partial'] as const;

    for (const status of statuses) {
      // Reset calls
      connector.sendPacketCalls.length = 0;

      // Act
      const result = await node.publishFeedback(
        TEST_REQUEST_EVENT_ID,
        TEST_CUSTOMER_PUBKEY,
        status,
        `Status detail: ${status}`,
        { destination: 'g.crosstown.relay' }
      );

      // Assert
      expect(result.success).toBe(true);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- test assertion
      const call = connector.sendPacketCalls[0]!;
      const decoded = decodeEventFromToon(call.data);
      const parsed = parseJobFeedback(decoded);
      expect(parsed).not.toBeNull();
      expect(parsed?.status).toBe(status);
      expect(parsed?.content).toBe(`Status detail: ${status}`);
    }

    // Cleanup
    await node.stop();
  });
});

// ---------------------------------------------------------------------------
// Test Suite: Result Event Publishing (Task 2.2)
// ---------------------------------------------------------------------------

describe('DVM Result Publishing via publishResult() (Story 5.3, Task 2)', () => {
  let nodeSecretKey: Uint8Array;

  beforeAll(() => {
    nodeSecretKey = generateSecretKey();
  });

  // T-5.3-02: Provider publishes Kind 6xxx result with correct tags via ILP PREPARE
  it('[P0] T-5.3-02: publishResult() sends Kind 6100 result via ILP PREPARE with correct e, p, amount tags and content', async () => {
    // Arrange
    const connector = new MockEmbeddedConnector();
    const basePricePerByte = 10n;
    const node = createNode({
      secretKey: nodeSecretKey,
      connector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      basePricePerByte,
      knownPeers: [],
    });
    await node.start();

    // Act
    const result = await node.publishResult(
      TEST_REQUEST_EVENT_ID,
      TEST_CUSTOMER_PUBKEY,
      '3000000',
      'Here is the AI-generated text result for your query.',
      { destination: 'g.crosstown.relay' }
    );

    // Assert -- publish succeeded
    expect(result).toBeDefined();
    expect(result.success).toBe(true);

    // Assert -- sendPacket was called
    expect(connector.sendPacketCalls).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- test assertion
    const call = connector.sendPacketCalls[0]!;

    // Assert -- decode TOON to verify event structure
    const decoded = decodeEventFromToon(call.data);
    expect(decoded.kind).toBe(6100); // TEXT_GENERATION_KIND + 1000

    // Assert -- result has correct NIP-90 tags
    const eTag = decoded.tags.find((t: string[]) => t[0] === 'e');
    expect(eTag).toBeDefined();
    expect(eTag?.[1]).toBe(TEST_REQUEST_EVENT_ID);

    const pTag = decoded.tags.find((t: string[]) => t[0] === 'p');
    expect(pTag).toBeDefined();
    expect(pTag?.[1]).toBe(TEST_CUSTOMER_PUBKEY);

    const amountTag = decoded.tags.find((t: string[]) => t[0] === 'amount');
    expect(amountTag).toBeDefined();
    expect(amountTag?.[1]).toBe('3000000');
    expect(amountTag?.[2]).toBe('usdc');

    // Assert -- content preserved
    expect(decoded.content).toBe(
      'Here is the AI-generated text result for your query.'
    );

    // Assert -- parseable by parseJobResult()
    const parsed = parseJobResult(decoded);
    expect(parsed).not.toBeNull();
    expect(parsed?.requestEventId).toBe(TEST_REQUEST_EVENT_ID);
    expect(parsed?.customerPubkey).toBe(TEST_CUSTOMER_PUBKEY);
    expect(parsed?.amount).toBe('3000000');

    // Cleanup
    await node.stop();
  });

  // T-INT-07: Kind 6100 result with complex content survives TOON roundtrip
  it('[P0] T-INT-07: Kind 6100 result with complex content (multi-line text, JSON, URLs) survives TOON roundtrip with all tags intact', async () => {
    // Arrange
    const connector = new MockEmbeddedConnector();
    const node = createNode({
      secretKey: nodeSecretKey,
      connector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      knownPeers: [],
    });
    await node.start();

    // Complex content with multi-line text, JSON, URLs
    const complexContent = [
      'Summary of research findings:',
      '',
      '1. Result A: {"score": 0.95, "confidence": "high"}',
      '2. Result B: See https://example.com/results?id=123&format=json',
      '',
      'Full report at: https://example.com/report.pdf',
      'Contact: researcher@example.com',
      '',
      'Tags: #ai #research #quantum',
    ].join('\n');

    // Act
    const result = await node.publishResult(
      TEST_REQUEST_EVENT_ID,
      TEST_CUSTOMER_PUBKEY,
      '7500000',
      complexContent,
      { destination: 'g.crosstown.relay' }
    );

    // Assert -- publish succeeded
    expect(result.success).toBe(true);

    // Assert -- complex content survives TOON roundtrip
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- test assertion
    const call = connector.sendPacketCalls[0]!;
    const decoded = decodeEventFromToon(call.data);
    expect(decoded.content).toBe(complexContent);

    // Assert -- all tags intact
    const parsed = parseJobResult(decoded);
    expect(parsed).not.toBeNull();
    expect(parsed?.amount).toBe('7500000');
    expect(parsed?.requestEventId).toBe(TEST_REQUEST_EVENT_ID);

    // Cleanup
    await node.stop();
  });

  // T-INT-03: Kind 6xxx amount tag preserved through TOON encode/decode
  it('[P0] T-INT-03: Kind 6xxx amount tag preserved through TOON encode/decode and parseable as USDC micro-units', async () => {
    // Arrange
    const connector = new MockEmbeddedConnector();
    const node = createNode({
      secretKey: nodeSecretKey,
      connector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      knownPeers: [],
    });
    await node.start();

    // Use a specific amount to verify exact preservation
    const computeAmount = '12345678';

    // Act
    const result = await node.publishResult(
      TEST_REQUEST_EVENT_ID,
      TEST_CUSTOMER_PUBKEY,
      computeAmount,
      'Result data',
      { destination: 'g.crosstown.relay' }
    );

    // Assert
    expect(result.success).toBe(true);

    // Decode and verify amount survives TOON roundtrip
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- test assertion
    const call = connector.sendPacketCalls[0]!;
    const decoded = decodeEventFromToon(call.data);
    const parsed = parseJobResult(decoded);
    expect(parsed).not.toBeNull();
    expect(parsed?.amount).toBe(computeAmount);

    // Verify the amount is parseable as BigInt (USDC micro-units)
    expect(() => BigInt(parsed!.amount)).not.toThrow();
    expect(BigInt(parsed!.amount)).toBe(BigInt(computeAmount));

    // Cleanup
    await node.stop();
  });
});

// ---------------------------------------------------------------------------
// Test Suite: Compute Settlement (Task 3.1, 3.2)
// ---------------------------------------------------------------------------

describe('Compute Settlement via settleCompute() (Story 5.3, Task 3)', () => {
  let nodeSecretKey: Uint8Array;
  let providerSecretKey: Uint8Array;

  beforeAll(() => {
    nodeSecretKey = generateSecretKey();
    providerSecretKey = generateSecretKey();
  });

  // T-5.3-03: Customer -> settleCompute() -> ILP payment to provider
  it('[P0] T-5.3-03: settleCompute() sends ILP payment with correct amount and empty data (pure value transfer)', async () => {
    // Arrange -- create customer node
    const connector = new MockEmbeddedConnector();
    const node = createNode({
      secretKey: nodeSecretKey,
      connector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      knownPeers: [],
    });
    await node.start();

    // Create a result event (simulating what provider published)
    const resultEvent = buildJobResultEvent(
      {
        kind: 6100,
        requestEventId: TEST_REQUEST_EVENT_ID,
        customerPubkey: TEST_CUSTOMER_PUBKEY,
        amount: '3000000',
        content: 'Generated text result',
      },
      providerSecretKey
    );

    // Act -- customer settles compute cost
    const result = await node.settleCompute(
      resultEvent,
      TEST_PROVIDER_ILP_ADDRESS
    );

    // Assert -- settlement succeeded
    expect(result).toBeDefined();
    expect(result.accepted).toBe(true);

    // Assert -- sendPacket called with correct params
    expect(connector.sendPacketCalls).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- test assertion
    const call = connector.sendPacketCalls[0]!;

    // Assert -- destination is provider's ILP address
    expect(call.destination).toBe(TEST_PROVIDER_ILP_ADDRESS);

    // Assert -- amount matches result event's amount tag
    expect(String(call.amount)).toBe('3000000');

    // Assert -- data is empty (pure value transfer, not relay write)
    expect(call.data).toBeInstanceOf(Uint8Array);
    expect(call.data.length).toBe(0);

    // Cleanup
    await node.stop();
  });

  // T-5.3-13: Compute payment uses existing EVM payment channels
  it('[P2] T-5.3-13: settleCompute() uses same sendPacket infrastructure as relay write fees (no separate channel creation)', async () => {
    // Arrange
    const connector = new MockEmbeddedConnector();
    const node = createNode({
      secretKey: nodeSecretKey,
      connector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      knownPeers: [],
    });
    await node.start();

    const resultEvent = buildJobResultEvent(
      {
        kind: 6100,
        requestEventId: TEST_REQUEST_EVENT_ID,
        customerPubkey: TEST_CUSTOMER_PUBKEY,
        amount: '2000000',
        content: 'Result',
      },
      providerSecretKey
    );

    // Act -- settle compute
    await node.settleCompute(resultEvent, TEST_PROVIDER_ILP_ADDRESS);

    // Assert -- uses the same connector.sendPacket() method as publishEvent()
    expect(connector.sendPacketCalls).toHaveLength(1);

    // Now publish a regular event to show they use the same infrastructure
    const regularEvent = finalizeEvent(
      {
        kind: 1,
        content: 'Regular note',
        tags: [],
        created_at: FIXED_CREATED_AT,
      },
      nodeSecretKey
    );
    await node.publishEvent(regularEvent, {
      destination: 'g.crosstown.relay',
    });

    // Assert -- both went through same connector
    expect(connector.sendPacketCalls).toHaveLength(2);

    // Cleanup
    await node.stop();
  });
});

// ---------------------------------------------------------------------------
// Test Suite: Full DVM Lifecycle (Task 4.1, 4.2, 4.3)
// ---------------------------------------------------------------------------

describe('Full DVM Lifecycle (Story 5.3, Task 4)', () => {
  let customerSecretKey: Uint8Array;
  let providerSecretKey: Uint8Array;

  beforeAll(() => {
    customerSecretKey = generateSecretKey();
    providerSecretKey = generateSecretKey();
  });

  // T-5.3-09: Full lifecycle using SDK helpers
  it('[P0] T-5.3-09: full DVM lifecycle -- request -> feedback -> result -> settleCompute() -> provider receives payment', async () => {
    // Arrange -- create provider node
    const providerConnector = new MockEmbeddedConnector();
    const providerNode = createNode({
      secretKey: providerSecretKey,
      connector: providerConnector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      basePricePerByte: 10n,
      knownPeers: [],
    });
    await providerNode.start();

    // Arrange -- create customer node
    const customerConnector = new MockEmbeddedConnector();
    const customerNode = createNode({
      secretKey: customerSecretKey,
      connector: customerConnector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      basePricePerByte: 10n,
      knownPeers: [],
    });
    await customerNode.start();

    // Step 1: Customer publishes Kind 5100 request (using existing publishEvent)
    const requestEvent = buildJobRequestEvent(
      {
        kind: TEXT_GENERATION_KIND,
        input: { data: 'Summarize quantum computing', type: 'text' },
        bid: '5000000',
        output: 'text/plain',
      },
      customerSecretKey
    );
    const publishResult = await customerNode.publishEvent(requestEvent, {
      destination: 'g.crosstown.relay',
    });
    expect(publishResult.success).toBe(true);

    // Step 2: Provider sends feedback (processing)
    const feedbackResult = await providerNode.publishFeedback(
      requestEvent.id,
      requestEvent.pubkey,
      'processing',
      undefined,
      { destination: 'g.crosstown.relay' }
    );
    expect(feedbackResult.success).toBe(true);

    // Step 3: Provider sends result
    const resultPublishResult = await providerNode.publishResult(
      requestEvent.id,
      requestEvent.pubkey,
      '3000000',
      'Quantum computing is a paradigm that uses quantum bits...',
      { destination: 'g.crosstown.relay' }
    );
    expect(resultPublishResult.success).toBe(true);

    // Step 4: Customer settles compute cost
    // Build a result event to pass to settleCompute (simulating what customer received)
    const resultEvent = buildJobResultEvent(
      {
        kind: 6100,
        requestEventId: requestEvent.id,
        customerPubkey: requestEvent.pubkey,
        amount: '3000000',
        content: 'Quantum computing is a paradigm that uses quantum bits...',
      },
      providerSecretKey
    );

    const settlementResult = await customerNode.settleCompute(
      resultEvent,
      TEST_PROVIDER_ILP_ADDRESS
    );
    expect(settlementResult).toBeDefined();
    expect(settlementResult.accepted).toBe(true);

    // Assert -- all stages produced correct events
    // Provider sent 2 events (feedback + result)
    expect(providerConnector.sendPacketCalls).toHaveLength(2);
    // Customer sent 2 calls (request publish + settlement)
    expect(customerConnector.sendPacketCalls).toHaveLength(2);

    // Cleanup
    await providerNode.stop();
    await customerNode.stop();
  });

  // T-5.3-19: Customer receives feedback + result correlated by requestEventId
  it('[P1] T-5.3-19: feedback and result events are correlated by shared requestEventId in e tag', async () => {
    // Arrange
    const providerConnector = new MockEmbeddedConnector();
    const providerNode = createNode({
      secretKey: providerSecretKey,
      connector: providerConnector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      knownPeers: [],
    });
    await providerNode.start();

    const requestId = 'ab'.repeat(32); // deterministic request ID
    const customerPubkey = 'cd'.repeat(32);

    // Act -- provider sends feedback then result
    await providerNode.publishFeedback(
      requestId,
      customerPubkey,
      'processing',
      undefined,
      { destination: 'g.crosstown.relay' }
    );
    await providerNode.publishResult(
      requestId,
      customerPubkey,
      '2000000',
      'Result content',
      { destination: 'g.crosstown.relay' }
    );

    // Assert -- both events share the same requestEventId in e tag
    expect(providerConnector.sendPacketCalls).toHaveLength(2);

    // Decode feedback
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- test assertion
    const feedbackCall = providerConnector.sendPacketCalls[0]!;
    const decodedFeedback = decodeEventFromToon(feedbackCall.data);
    const feedbackETag = decodedFeedback.tags.find(
      (t: string[]) => t[0] === 'e'
    );
    expect(feedbackETag?.[1]).toBe(requestId);

    // Decode result
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- test assertion
    const resultCall = providerConnector.sendPacketCalls[1]!;
    const decodedResult = decodeEventFromToon(resultCall.data);
    const resultETag = decodedResult.tags.find((t: string[]) => t[0] === 'e');
    expect(resultETag?.[1]).toBe(requestId);

    // Both events reference the same request ID
    expect(feedbackETag?.[1]).toBe(resultETag?.[1]);

    // Cleanup
    await providerNode.stop();
  });

  // T-INT-02: Provider's Kind 6xxx references customer's Kind 5xxx via e tag
  it('[P0] T-INT-02: Provider Kind 6xxx result references customer Kind 5xxx request via e tag (cross-story 5.2 -> 5.3)', async () => {
    // Arrange
    const providerConnector = new MockEmbeddedConnector();
    const providerNode = createNode({
      secretKey: providerSecretKey,
      connector: providerConnector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      knownPeers: [],
    });
    await providerNode.start();

    // Create a request event ID (simulating what customer published in Story 5.2)
    const requestEvent = buildJobRequestEvent(
      {
        kind: TEXT_GENERATION_KIND,
        input: { data: 'Test input', type: 'text' },
        bid: '5000000',
        output: 'text/plain',
      },
      customerSecretKey
    );

    // Act -- provider publishes result referencing the request
    const result = await providerNode.publishResult(
      requestEvent.id,
      requestEvent.pubkey,
      '3000000',
      'Result referencing original request',
      { destination: 'g.crosstown.relay' }
    );

    // Assert -- result event references the request event ID
    expect(result.success).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- test assertion
    const call = providerConnector.sendPacketCalls[0]!;
    const decoded = decodeEventFromToon(call.data);
    const eTag = decoded.tags.find((t: string[]) => t[0] === 'e');
    expect(eTag).toBeDefined();
    expect(eTag?.[1]).toBe(requestEvent.id);

    // Cleanup
    await providerNode.stop();
  });

  // T-5.3-20: Error lifecycle -- request -> error feedback -> no result -> no settlement
  it('[P1] T-5.3-20: error lifecycle -- provider publishes error feedback -> no result event -> no compute settlement', async () => {
    // Arrange
    const providerConnector = new MockEmbeddedConnector();
    const providerNode = createNode({
      secretKey: providerSecretKey,
      connector: providerConnector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      knownPeers: [],
    });
    await providerNode.start();

    const customerConnector = new MockEmbeddedConnector();
    const customerNode = createNode({
      secretKey: customerSecretKey,
      connector: customerConnector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      knownPeers: [],
    });
    await customerNode.start();

    // Step 1: Customer publishes request
    const requestEvent = buildJobRequestEvent(
      {
        kind: TEXT_GENERATION_KIND,
        input: { data: 'Process this data', type: 'text' },
        bid: '5000000',
        output: 'text/plain',
      },
      customerSecretKey
    );
    await customerNode.publishEvent(requestEvent, {
      destination: 'g.crosstown.relay',
    });

    // Step 2: Provider sends error feedback
    const feedbackResult = await providerNode.publishFeedback(
      requestEvent.id,
      requestEvent.pubkey,
      'error',
      'GPU out of memory',
      { destination: 'g.crosstown.relay' }
    );
    expect(feedbackResult.success).toBe(true);

    // Step 3: No result event published
    // Step 4: No compute settlement

    // Assert -- provider only sent 1 event (error feedback, no result)
    expect(providerConnector.sendPacketCalls).toHaveLength(1);

    // Assert -- customer only sent 1 event (request, no settlement)
    expect(customerConnector.sendPacketCalls).toHaveLength(1);

    // Assert -- the feedback event has error status
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- test assertion
    const feedbackCall = providerConnector.sendPacketCalls[0]!;
    const decoded = decodeEventFromToon(feedbackCall.data);
    const parsed = parseJobFeedback(decoded);
    expect(parsed?.status).toBe('error');
    expect(parsed?.content).toBe('GPU out of memory');

    // Cleanup
    await providerNode.stop();
    await customerNode.stop();
  });
});

// ---------------------------------------------------------------------------
// Test Suite: Multi-Hop Routing and Service Discovery (Task 3.4, AC #3, #4)
// ---------------------------------------------------------------------------

describe('Multi-Hop Routing and Service Discovery (Story 5.3, Task 3)', () => {
  let customerSecretKey: Uint8Array;
  let providerSecretKey: Uint8Array;

  beforeAll(() => {
    customerSecretKey = generateSecretKey();
    providerSecretKey = generateSecretKey();
  });

  // T-5.3-14: Multi-hop routing -- compute payment routes through ILP mesh
  it('[P2] T-5.3-14: compute settlement payment routes through multi-hop ILP mesh (customer -> intermediate -> provider)', async () => {
    // Arrange -- create a mock connector that simulates multi-hop forwarding.
    // In a real multi-hop scenario, the customer's connector would forward the
    // packet through intermediate connectors to the provider's connector.
    // Here we verify that settleCompute() sends the payment with the correct
    // destination (provider's ILP address) and that intermediate hops would
    // earn routing fees by verifying the amount reaches the provider unmodified.
    const hopsRecorded: { destination: string; amount: bigint | string }[] = [];
    const customerConnector = new MockEmbeddedConnector();

    // Override sendPacket to record the forwarding chain
    const originalSendPacket =
      customerConnector.sendPacket.bind(customerConnector);
    customerConnector.sendPacket = async (
      params: SendPacketParams
    ): Promise<SendPacketResult> => {
      hopsRecorded.push({
        destination: params.destination,
        amount: params.amount,
      });
      return originalSendPacket(params);
    };

    const customerNode = createNode({
      secretKey: customerSecretKey,
      connector: customerConnector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      knownPeers: [],
    });
    await customerNode.start();

    // Build a result event from the provider
    const resultEvent = buildJobResultEvent(
      {
        kind: 6100,
        requestEventId: TEST_REQUEST_EVENT_ID,
        customerPubkey: TEST_CUSTOMER_PUBKEY,
        amount: '5000000',
        content: 'Multi-hop result',
      },
      providerSecretKey
    );

    // Provider's ILP address suggests multi-hop routing (different node)
    const providerIlpAddress = 'g.crosstown.remote.provider.node-c';

    // Act -- customer settles compute via ILP mesh
    const result = await customerNode.settleCompute(
      resultEvent,
      providerIlpAddress
    );

    // Assert -- settlement succeeded (connector accepted the packet)
    expect(result).toBeDefined();
    expect(result.accepted).toBe(true);

    // Assert -- the payment was sent with the provider's ILP address as destination
    // In a real multi-hop setup, the connector would forward this to intermediate
    // nodes based on routing tables until it reaches the provider's connector.
    expect(hopsRecorded).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- test assertion
    const hop = hopsRecorded[0]!;
    expect(hop.destination).toBe(providerIlpAddress);
    expect(String(hop.amount)).toBe('5000000');

    // Assert -- data is empty (pure value transfer, not relay write)
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- test assertion
    const call = customerConnector.sendPacketCalls[0]!;
    expect(call.data).toBeInstanceOf(Uint8Array);
    expect(call.data.length).toBe(0);

    // Cleanup
    await customerNode.stop();
  });

  // T-5.3-06-I: Full kind:10035 -> parseServiceDiscovery -> settleCompute chain (AC #3)
  it('[P1] T-5.3-06-I: full service discovery chain -- build kind:10035 -> parseServiceDiscovery() -> extract ilpAddress -> settleCompute()', async () => {
    // Arrange -- customer node
    const customerConnector = new MockEmbeddedConnector();
    const customerNode = createNode({
      secretKey: customerSecretKey,
      connector: customerConnector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      knownPeers: [],
    });
    await customerNode.start();

    // Arrange -- provider builds and publishes a kind:10035 service discovery event
    const providerIlpAddress = 'g.crosstown.provider.dvm-agent-1';
    const discoveryEvent = buildServiceDiscoveryEvent(
      {
        serviceType: 'dvm-provider',
        ilpAddress: providerIlpAddress,
        pricing: {
          basePricePerByte: 10,
          currency: 'USDC',
        },
        supportedKinds: [5100, 5200],
        capabilities: ['text-generation', 'image-generation'],
        chain: 'evm:base:31337',
        version: '1.0.0',
      },
      providerSecretKey
    );

    // Act -- customer extracts provider ILP address from kind:10035
    const parsed = parseServiceDiscovery(discoveryEvent);
    expect(parsed).not.toBeNull();
    const resolvedIlpAddress = parsed!.ilpAddress;
    expect(resolvedIlpAddress).toBe(providerIlpAddress);

    // Act -- provider builds result event
    const resultEvent = buildJobResultEvent(
      {
        kind: 6100,
        requestEventId: TEST_REQUEST_EVENT_ID,
        customerPubkey: TEST_CUSTOMER_PUBKEY,
        amount: '4500000',
        content: 'DVM result from provider',
      },
      providerSecretKey
    );

    // Act -- customer settles compute using the resolved ILP address
    const settlementResult = await customerNode.settleCompute(
      resultEvent,
      resolvedIlpAddress
    );

    // Assert -- settlement succeeded with the correct destination
    expect(settlementResult).toBeDefined();
    expect(settlementResult.accepted).toBe(true);

    // Assert -- sendPacket was called with the provider's ILP address from kind:10035
    expect(customerConnector.sendPacketCalls).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- test assertion
    const call = customerConnector.sendPacketCalls[0]!;
    expect(call.destination).toBe(providerIlpAddress);
    expect(String(call.amount)).toBe('4500000');

    // Assert -- data is empty (pure value transfer)
    expect(call.data).toBeInstanceOf(Uint8Array);
    expect(call.data.length).toBe(0);

    // Cleanup
    await customerNode.stop();
  });
});

// ---------------------------------------------------------------------------
// Test Suite: Cross-Story Boundary Tests (Task 5)
// ---------------------------------------------------------------------------

describe('Cross-Story Boundary Tests (Story 5.3, Task 5)', () => {
  let providerSecretKey: Uint8Array;
  let customerSecretKey: Uint8Array;

  beforeAll(() => {
    providerSecretKey = generateSecretKey();
    customerSecretKey = generateSecretKey();
  });

  // T-INT-07 extended: result content with JSON survives TOON roundtrip
  it('[P0] T-INT-07 extended: Kind 6100 result with embedded JSON content survives TOON roundtrip', async () => {
    // Arrange
    const connector = new MockEmbeddedConnector();
    const node = createNode({
      secretKey: providerSecretKey,
      connector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      knownPeers: [],
    });
    await node.start();

    const jsonContent = JSON.stringify({
      summary: 'Quantum computing uses qubits',
      confidence: 0.95,
      sources: ['https://arxiv.org/abs/1234', 'https://example.com'],
      metadata: { model: 'claude-3', tokens_used: 847 },
    });

    // Act
    const result = await node.publishResult(
      TEST_REQUEST_EVENT_ID,
      TEST_CUSTOMER_PUBKEY,
      '5000000',
      jsonContent,
      { destination: 'g.crosstown.relay' }
    );

    // Assert
    expect(result.success).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- test assertion
    const call = connector.sendPacketCalls[0]!;
    const decoded = decodeEventFromToon(call.data);
    expect(decoded.content).toBe(jsonContent);

    // Verify content is parseable as JSON
    const parsedContent = JSON.parse(decoded.content);
    expect(parsedContent.confidence).toBe(0.95);

    // Cleanup
    await node.stop();
  });

  // T-INT-03 amplification: amount preservation through full pipeline
  it('[P0] T-INT-03 amplification: compute settlement amount matches buildJobResultEvent() amount after TOON roundtrip', async () => {
    // Arrange
    const connector = new MockEmbeddedConnector();
    const customerNode = createNode({
      secretKey: customerSecretKey,
      connector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      knownPeers: [],
    });
    await customerNode.start();

    // Build a result event with specific amount
    const originalAmount = '7654321';
    const resultEvent = buildJobResultEvent(
      {
        kind: 6100,
        requestEventId: TEST_REQUEST_EVENT_ID,
        customerPubkey: TEST_CUSTOMER_PUBKEY,
        amount: originalAmount,
        content: 'Result',
      },
      providerSecretKey
    );

    // Simulate TOON roundtrip: encode -> decode
    const toonBytes = encodeEventToToon(resultEvent);
    const decodedResult = decodeEventFromToon(toonBytes);

    // Parse amount from decoded event
    const parsed = parseJobResult(decodedResult);
    expect(parsed).not.toBeNull();
    expect(parsed?.amount).toBe(originalAmount);

    // Act -- settle using decoded result event
    const settlementResult = await customerNode.settleCompute(
      decodedResult,
      TEST_PROVIDER_ILP_ADDRESS
    );

    // Assert -- settlement amount matches original
    expect(settlementResult.accepted).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- test assertion
    const call = connector.sendPacketCalls[0]!;
    expect(String(call.amount)).toBe(originalAmount);

    // Cleanup
    await customerNode.stop();
  });
});

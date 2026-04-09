/**
 * E2E Test: ServiceNode.publishEvent() (Story 2.6)
 *
 * **Purpose:**
 * Verify that ServiceNode.publishEvent() delivers a Nostr event end-to-end
 * through the full SDK pipeline: TOON encode -> ILP packet -> connector route
 * -> destination pipeline (verify -> price -> dispatch) -> handler receives event.
 *
 * **Architecture:**
 * Uses an in-memory ILP router to connect two ServiceNode instances (sender
 * and receiver) without external infrastructure. The router implements
 * longest-prefix matching on ILP addresses, identical to the pattern used
 * in core/__integration__/five-peer-bootstrap.test.ts.
 *
 * **What this validates:**
 * - AC#1: TOON-encode, price, base64, send via ilpClient.sendIlpPacket()
 * - AC#4: PublishEventResult success/failure shapes in realistic scenarios
 * - Full data flow: sender publishEvent -> receiver handler -> event decoded
 * - Cross-node ILP routing with correct amount pricing
 * - Receiver pipeline: shallow parse -> verify -> price -> dispatch
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
} from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import {
  createNode,
  type ServiceNode,
  type HandlerContext,
  type PublishEventResult,
} from '@toon-protocol/sdk';
import type {
  EmbeddableConnectorLike,
  HandlePacketRequest,
  HandlePacketResponse,
} from '@toon-protocol/core';
import type { SendPacketParams, SendPacketResult } from '@toon-protocol/core';
import type { RegisterPeerParams } from '@toon-protocol/core';
import { encodeEventToToon, decodeEventFromToon } from '@toon-protocol/relay';

// ---------------------------------------------------------------------------
// InMemoryIlpRouter -- shared routing fabric between mock connectors
// ---------------------------------------------------------------------------

class InMemoryIlpRouter {
  private routes = new Map<string, MockConnectorWithRouter>();

  register(ilpPrefix: string, connector: MockConnectorWithRouter): void {
    this.routes.set(ilpPrefix, connector);
  }

  async routePacket(params: SendPacketParams): Promise<SendPacketResult> {
    // Find longest-prefix match
    let bestMatch = '';
    let target: MockConnectorWithRouter | undefined;

    for (const [prefix, connector] of this.routes) {
      if (
        params.destination.startsWith(prefix) &&
        prefix.length > bestMatch.length
      ) {
        bestMatch = prefix;
        target = connector;
      }
    }

    if (!target) {
      return {
        type: 'reject',
        code: 'F02',
        message: `No route for ${params.destination}`,
      };
    }

    const handler = target.getPacketHandler();
    if (!handler) {
      return {
        type: 'reject',
        code: 'T00',
        message: 'No packet handler registered on target connector',
      };
    }

    // Convert SendPacketParams -> HandlePacketRequest
    const request: HandlePacketRequest = {
      amount: params.amount.toString(),
      destination: params.destination,
      data: Buffer.from(params.data).toString('base64'),
    };

    const response = await handler(request);

    // Convert HandlePacketResponse -> SendPacketResult
    if (response.accept) {
      return {
        type: 'fulfill',
        fulfillment: response.fulfillment
          ? Uint8Array.from(Buffer.from(response.fulfillment, 'base64'))
          : new Uint8Array(32),
      };
    }

    return {
      type: 'reject',
      code: response.code,
      message: response.message,
    };
  }
}

// ---------------------------------------------------------------------------
// MockConnectorWithRouter -- EmbeddableConnectorLike backed by the router
// ---------------------------------------------------------------------------

class MockConnectorWithRouter implements EmbeddableConnectorLike {
  readonly registeredPeers = new Map<string, RegisterPeerParams>();
  private packetHandler:
    | ((
        req: HandlePacketRequest
      ) => HandlePacketResponse | Promise<HandlePacketResponse>)
    | null = null;

  constructor(private router: InMemoryIlpRouter) {}

  async sendPacket(params: SendPacketParams): Promise<SendPacketResult> {
    return this.router.routePacket(params);
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

  getPacketHandler() {
    return this.packetHandler;
  }
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('ServiceNode.publishEvent() E2E (Story 2.6)', () => {
  let router: InMemoryIlpRouter;
  let senderKey: Uint8Array;
  let senderPubkey: string;
  let receiverKey: Uint8Array;
  let _receiverPubkey: string;
  let senderConnector: MockConnectorWithRouter;
  let receiverConnector: MockConnectorWithRouter;
  let senderNode: ServiceNode;
  let receiverNode: ServiceNode;

  // Track events received by the receiver handler
  const receivedEvents: NostrEvent[] = [];
  const receivedAmounts: bigint[] = [];

  const SENDER_ILP_ADDRESS = 'g.toon.sender';
  const RECEIVER_ILP_ADDRESS = 'g.toon.receiver';
  const BASE_PRICE_PER_BYTE = 10n;

  beforeAll(async () => {
    // Generate deterministic keypairs for sender and receiver
    senderKey = generateSecretKey();
    senderPubkey = getPublicKey(senderKey);
    receiverKey = generateSecretKey();
    _receiverPubkey = getPublicKey(receiverKey);

    // Create shared ILP router
    router = new InMemoryIlpRouter();

    // Create connectors backed by the router
    senderConnector = new MockConnectorWithRouter(router);
    receiverConnector = new MockConnectorWithRouter(router);

    // Register ILP address prefixes on the router
    router.register(SENDER_ILP_ADDRESS, senderConnector);
    router.register(RECEIVER_ILP_ADDRESS, receiverConnector);

    // Create receiver node with event handler
    receiverNode = createNode({
      secretKey: receiverKey,
      connector: receiverConnector,
      ilpAddress: RECEIVER_ILP_ADDRESS,
      basePricePerByte: BASE_PRICE_PER_BYTE,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      knownPeers: [],
    });

    // Register a handler on the receiver that captures events
    receiverNode.on(1, async (ctx: HandlerContext) => {
      const decoded = ctx.decode();
      receivedEvents.push(decoded);
      receivedAmounts.push(ctx.amount);
      return ctx.accept();
    });

    // Create sender node
    senderNode = createNode({
      secretKey: senderKey,
      connector: senderConnector,
      ilpAddress: SENDER_ILP_ADDRESS,
      basePricePerByte: BASE_PRICE_PER_BYTE,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      knownPeers: [],
    });

    // Start both nodes
    await receiverNode.start();
    await senderNode.start();
  });

  afterAll(async () => {
    await senderNode.stop();
    await receiverNode.stop();
  });

  // ---------------------------------------------------------------------------
  // P0: Happy path -- publish event and verify end-to-end delivery
  // ---------------------------------------------------------------------------

  it('publishes a signed event from sender to receiver via ILP routing', async () => {
    // Arrange: create and sign a Nostr event with the sender's key
    const testContent = `E2E test event - ${Date.now()}`;
    const event = finalizeEvent(
      {
        kind: 1,
        content: testContent,
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      },
      senderKey
    );

    // Clear tracking arrays
    receivedEvents.length = 0;
    receivedAmounts.length = 0;

    // Act: publish via sender node
    const result: PublishEventResult = await senderNode.publishEvent(event, {
      destination: RECEIVER_ILP_ADDRESS,
    });

    // Assert: success result shape (AC#4)
    expect(result.success).toBe(true);
    expect(result.eventId).toBe(event.id);
    // fulfillment removed from connector v2.2.0 application API (handled internally)
    // Verify success shape without fulfillment assertion

    // Assert: receiver's handler received exactly one event
    expect(receivedEvents).toHaveLength(1);
    const received = receivedEvents[0]!;

    // Assert: decoded event matches the original
    expect(received.id).toBe(event.id);
    expect(received.pubkey).toBe(senderPubkey);
    expect(received.content).toBe(testContent);
    expect(received.kind).toBe(1);
    expect(received.sig).toBe(event.sig);
  });

  it('computes correct payment amount based on TOON byte length', async () => {
    // Arrange: create event and compute expected amount
    const event = finalizeEvent(
      {
        kind: 1,
        content: 'Amount verification test',
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      },
      senderKey
    );
    const expectedToonLength = BigInt(encodeEventToToon(event).length);
    const expectedAmount = BASE_PRICE_PER_BYTE * expectedToonLength;

    // Clear tracking arrays
    receivedEvents.length = 0;
    receivedAmounts.length = 0;

    // Act
    await senderNode.publishEvent(event, {
      destination: RECEIVER_ILP_ADDRESS,
    });

    // Assert: receiver sees the correct payment amount
    expect(receivedAmounts).toHaveLength(1);
    expect(receivedAmounts[0]).toBe(expectedAmount);
  });

  it('publishes multiple events in sequence and all arrive at receiver', async () => {
    // Clear tracking arrays
    receivedEvents.length = 0;

    const eventCount = 3;
    const eventIds: string[] = [];

    // Act: publish 3 events in sequence
    for (let i = 0; i < eventCount; i++) {
      const event = finalizeEvent(
        {
          kind: 1,
          content: `Sequential event ${i + 1}`,
          tags: [],
          created_at: Math.floor(Date.now() / 1000) + i,
        },
        senderKey
      );
      eventIds.push(event.id);

      const result = await senderNode.publishEvent(event, {
        destination: RECEIVER_ILP_ADDRESS,
      });
      expect(result.success).toBe(true);
    }

    // Assert: all events arrived in order
    expect(receivedEvents).toHaveLength(eventCount);
    for (let i = 0; i < eventCount; i++) {
      expect(receivedEvents[i]!.id).toBe(eventIds[i]);
      expect(receivedEvents[i]!.content).toBe(`Sequential event ${i + 1}`);
    }
  });

  // ---------------------------------------------------------------------------
  // P0: Rejection scenarios
  // ---------------------------------------------------------------------------

  it('returns rejection result when destination has no route', async () => {
    // Arrange: create event targeting an unregistered ILP address
    const event = finalizeEvent(
      {
        kind: 1,
        content: 'No route test',
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      },
      senderKey
    );

    // Act: publish to a non-existent destination
    const result = await senderNode.publishEvent(event, {
      destination: 'g.nonexistent.peer',
    });

    // Assert: rejection result shape (AC#4)
    expect(result.success).toBe(false);
    expect(result.eventId).toBe(event.id);
    expect(result.code).toBeDefined();
    expect(result.message).toBeDefined();
  });

  it('returns rejection when receiver has no handler for the event kind', async () => {
    // Arrange: create an event with kind 42 (no handler registered on receiver)
    const event = finalizeEvent(
      {
        kind: 42,
        content: 'Unhandled kind test',
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      },
      senderKey
    );

    // Act
    const result = await senderNode.publishEvent(event, {
      destination: RECEIVER_ILP_ADDRESS,
    });

    // Assert: rejected because receiver has no handler for kind 42
    expect(result.success).toBe(false);
    expect(result.eventId).toBe(event.id);
    expect(result.code).toBe('F00');
  });

  // ---------------------------------------------------------------------------
  // P1: Pricing validation at receiver end
  // ---------------------------------------------------------------------------

  it('receiver validates payment amount through full pricing pipeline', async () => {
    // This test verifies that the receiver's pricing validator accepts
    // the payment computed by publishEvent(). The sender computes:
    //   amount = basePricePerByte * toonData.length
    // The receiver validates:
    //   received_amount >= basePricePerByte * rawBytes.length
    // Since both use the same basePricePerByte (10n) and the TOON bytes
    // are identical, the payment should always be accepted.

    const event = finalizeEvent(
      {
        kind: 1,
        content: 'Pricing pipeline verification',
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      },
      senderKey
    );

    receivedEvents.length = 0;

    const result = await senderNode.publishEvent(event, {
      destination: RECEIVER_ILP_ADDRESS,
    });

    // Payment should be accepted (amount computed by sender matches receiver's pricing)
    expect(result.success).toBe(true);
    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0]!.content).toBe('Pricing pipeline verification');
  });

  // ---------------------------------------------------------------------------
  // P1: Signature verification at receiver end
  // ---------------------------------------------------------------------------

  it('receiver verifies Schnorr signature of incoming event', async () => {
    // The sender signs the event with senderKey, the TOON-encoded event
    // includes the valid Schnorr signature, and the receiver's verification
    // pipeline validates it before dispatching to the handler.

    const event = finalizeEvent(
      {
        kind: 1,
        content: 'Signature verification E2E',
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      },
      senderKey
    );

    receivedEvents.length = 0;

    const result = await senderNode.publishEvent(event, {
      destination: RECEIVER_ILP_ADDRESS,
    });

    // If signature verification failed, the packet would be rejected with F06.
    // A success result proves the signature was verified correctly.
    expect(result.success).toBe(true);
    expect(receivedEvents).toHaveLength(1);

    // Verify the received event has the correct pubkey (from the signature)
    expect(receivedEvents[0]!.pubkey).toBe(senderPubkey);
  });

  // ---------------------------------------------------------------------------
  // P1: Event metadata preservation
  // ---------------------------------------------------------------------------

  it('preserves all Nostr event fields through TOON encode/decode cycle', async () => {
    // Verify that all standard Nostr event fields survive the
    // publishEvent -> TOON encode -> ILP packet -> TOON decode cycle.

    const tags = [
      ['e', 'a'.repeat(64)],
      ['p', 'b'.repeat(64)],
      ['t', 'toon'],
    ];
    const createdAt = 1700000000;
    const event = finalizeEvent(
      {
        kind: 1,
        content: 'Metadata preservation test',
        tags,
        created_at: createdAt,
      },
      senderKey
    );

    receivedEvents.length = 0;

    const result = await senderNode.publishEvent(event, {
      destination: RECEIVER_ILP_ADDRESS,
    });
    expect(result.success).toBe(true);

    expect(receivedEvents).toHaveLength(1);
    const received = receivedEvents[0]!;

    // Verify all standard fields
    expect(received.id).toBe(event.id);
    expect(received.pubkey).toBe(event.pubkey);
    expect(received.created_at).toBe(createdAt);
    expect(received.kind).toBe(1);
    expect(received.content).toBe('Metadata preservation test');
    expect(received.sig).toBe(event.sig);

    // Verify tags are preserved
    expect(received.tags).toHaveLength(3);
    expect(received.tags[0]).toEqual(['e', 'a'.repeat(64)]);
    expect(received.tags[1]).toEqual(['p', 'b'.repeat(64)]);
    expect(received.tags[2]).toEqual(['t', 'toon']);
  });

  // ---------------------------------------------------------------------------
  // P2: Different event kinds
  // ---------------------------------------------------------------------------

  it('receiver dispatches different event kinds to appropriate handlers', async () => {
    // Register a handler for kind 30023 (long-form content) on a fresh receiver
    const receiverKey2 = generateSecretKey();
    const receiverConnector2 = new MockConnectorWithRouter(router);
    const receiverIlp2 = 'g.toon.receiver2';
    router.register(receiverIlp2, receiverConnector2);

    const kind1Events: NostrEvent[] = [];
    const kind30023Events: NostrEvent[] = [];

    const receiver2 = createNode({
      secretKey: receiverKey2,
      connector: receiverConnector2,
      ilpAddress: receiverIlp2,
      basePricePerByte: BASE_PRICE_PER_BYTE,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      knownPeers: [],
    });

    receiver2
      .on(1, async (ctx: HandlerContext) => {
        kind1Events.push(ctx.decode());
        return ctx.accept();
      })
      .on(30023, async (ctx: HandlerContext) => {
        kind30023Events.push(ctx.decode());
        return ctx.accept();
      });

    await receiver2.start();

    try {
      // Publish kind:1 event
      const event1 = finalizeEvent(
        {
          kind: 1,
          content: 'Short note',
          tags: [],
          created_at: Math.floor(Date.now() / 1000),
        },
        senderKey
      );

      const result1 = await senderNode.publishEvent(event1, {
        destination: receiverIlp2,
      });
      expect(result1.success).toBe(true);

      // Publish kind:30023 event
      const event30023 = finalizeEvent(
        {
          kind: 30023,
          content: 'Long-form article content',
          tags: [['d', 'test-article']],
          created_at: Math.floor(Date.now() / 1000),
        },
        senderKey
      );

      const result30023 = await senderNode.publishEvent(event30023, {
        destination: receiverIlp2,
      });
      expect(result30023.success).toBe(true);

      // Assert: each kind went to the correct handler
      expect(kind1Events).toHaveLength(1);
      expect(kind1Events[0]!.content).toBe('Short note');

      expect(kind30023Events).toHaveLength(1);
      expect(kind30023Events[0]!.content).toBe('Long-form article content');
    } finally {
      await receiver2.stop();
    }
  });

  // ---------------------------------------------------------------------------
  // P2: Custom basePricePerByte on sender
  // ---------------------------------------------------------------------------

  it('sender with higher basePricePerByte sends sufficient payment to receiver', async () => {
    // Create a sender with a higher basePricePerByte than the receiver.
    // The receiver should accept because the payment exceeds the minimum.
    const senderKey2 = generateSecretKey();
    const senderConnector2 = new MockConnectorWithRouter(router);
    const senderIlp2 = 'g.toon.sender2';
    router.register(senderIlp2, senderConnector2);

    const sender2 = createNode({
      secretKey: senderKey2,
      connector: senderConnector2,
      ilpAddress: senderIlp2,
      basePricePerByte: 50n, // 5x the receiver's price
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      knownPeers: [],
    });
    await sender2.start();

    receivedEvents.length = 0;
    receivedAmounts.length = 0;

    try {
      const event = finalizeEvent(
        {
          kind: 1,
          content: 'High price sender test',
          tags: [],
          created_at: Math.floor(Date.now() / 1000),
        },
        senderKey2
      );

      const result = await sender2.publishEvent(event, {
        destination: RECEIVER_ILP_ADDRESS,
      });

      // Receiver accepts because 50n/byte > 10n/byte minimum
      expect(result.success).toBe(true);
      expect(receivedEvents).toHaveLength(1);

      // Verify the amount is 50n * toonLength (not 10n)
      const expectedToonLength = BigInt(encodeEventToToon(event).length);
      expect(receivedAmounts[0]).toBe(50n * expectedToonLength);
    } finally {
      await sender2.stop();
    }
  });

  // ---------------------------------------------------------------------------
  // P2: Guard validations (not-started, missing destination)
  // ---------------------------------------------------------------------------

  it('throws NodeError when calling publishEvent on a stopped node', async () => {
    // Create a node, start it, stop it, then try publishEvent
    const tempKey = generateSecretKey();
    const tempConnector = new MockConnectorWithRouter(router);
    const tempNode = createNode({
      secretKey: tempKey,
      connector: tempConnector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      knownPeers: [],
    });
    await tempNode.start();
    await tempNode.stop();

    const event = finalizeEvent(
      {
        kind: 1,
        content: 'Should not be sent',
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      },
      tempKey
    );

    await expect(
      tempNode.publishEvent(event, { destination: RECEIVER_ILP_ADDRESS })
    ).rejects.toThrow(/Cannot publish: node not started/);
  });

  it('throws NodeError when destination is not provided', async () => {
    const event = finalizeEvent(
      {
        kind: 1,
        content: 'Missing destination',
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      },
      senderKey
    );

    await expect(senderNode.publishEvent(event)).rejects.toThrow(
      /destination is required/
    );
  });
});

// @ts-nocheck — ATDD Red Phase: imports reference exports that don't exist yet
/**
 * Integration Tests: createNode() Composition with Lifecycle (Story 1.7)
 *
 * ATDD Red Phase - tests will fail until SDK implementation exists
 *
 * Tests that createNode(config) returns a fully wired ServiceNode with:
 * - Handler registry wired to connector via PaymentHandler bridge
 * - Verification and pricing pipelines inserted before handler dispatch
 * - start() / stop() lifecycle management
 * - Full pipeline: TOON event -> shallow parse -> verify signature -> check pricing -> dispatch -> accept/reject
 *
 * Prerequisites:
 *   These tests use an embedded connector (MockConnector) with in-process
 *   packet delivery. No external infrastructure required for most tests.
 *   The full pipeline test creates a real TOON-encoded signed Nostr event.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
} from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';

// --- Imports from @crosstown/sdk (DOES NOT EXIST YET) ---
import {
  createNode,
  NodeError,
  type ServiceNode,
  type NodeConfig,
  type StartResult,
  type HandlerContext,
} from '../index.js';

// --- Imports from @crosstown/core (exists) ---
import type {
  HandlePacketRequest,
  HandlePacketResponse,
  EmbeddableConnectorLike,
} from '@crosstown/core';
import type { SendPacketParams, SendPacketResult } from '@crosstown/core';
import type { RegisterPeerParams } from '@crosstown/core';

// --- Import from @crosstown/relay (exists, for TOON encoding) ---
import { encodeEventToToon, decodeEventFromToon } from '@crosstown/relay';

// ---------------------------------------------------------------------------
// Mock Embedded Connector
// ---------------------------------------------------------------------------

class MockEmbeddedConnector implements EmbeddableConnectorLike {
  public packetHandler:
    | ((
        req: HandlePacketRequest
      ) => HandlePacketResponse | Promise<HandlePacketResponse>)
    | null = null;
  public readonly registeredPeers = new Map<string, RegisterPeerParams>();

  async sendPacket(_params: SendPacketParams): Promise<SendPacketResult> {
    return { type: 'reject', code: 'F02', message: 'No route' };
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
   * Used by tests to exercise the full pipeline without a real connector.
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

function createTestSecretKey(): Uint8Array {
  return generateSecretKey();
}

function createSignedToonEvent(
  secretKey: Uint8Array,
  kind: number,
  content: string
): { event: NostrEvent; toonBytes: Uint8Array; toonBase64: string } {
  const event = finalizeEvent(
    {
      kind,
      content,
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
    },
    secretKey
  );
  const toonBytes = encodeEventToToon(event);
  const toonBase64 = Buffer.from(toonBytes).toString('base64');
  return { event, toonBytes, toonBase64 };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('createNode() Composition with Lifecycle', () => {
  let secretKey: Uint8Array;
  let pubkey: string;
  let connector: MockEmbeddedConnector;

  beforeAll(() => {
    secretKey = createTestSecretKey();
    pubkey = getPublicKey(secretKey);
    connector = new MockEmbeddedConnector();
  });

  // -------------------------------------------------------------------------
  // [P0] Core composition — createNode returns wired ServiceNode
  // -------------------------------------------------------------------------

  it.skip('[P0] createNode(config) returns ServiceNode with handler registry wired to connector', () => {
    // Arrange
    const handler = vi.fn();
    const config: NodeConfig = {
      secretKey,
      connector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      handlers: { 1: handler },
    };

    // Act
    const node: ServiceNode = createNode(config);

    // Assert
    expect(node).toBeDefined();
    expect(node.start).toBeInstanceOf(Function);
    expect(node.stop).toBeInstanceOf(Function);
    expect(node.pubkey).toBeDefined();
    expect(node.evmAddress).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // [P0] node.pubkey returns x-only Schnorr public key
  // -------------------------------------------------------------------------

  it.skip('[P0] node.pubkey returns the x-only public key derived from secretKey', () => {
    // Arrange
    const config: NodeConfig = {
      secretKey,
      connector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
    };

    // Act
    const node = createNode(config);

    // Assert
    expect(node.pubkey).toBe(pubkey);
    expect(node.pubkey).toMatch(/^[0-9a-f]{64}$/);
  });

  // -------------------------------------------------------------------------
  // [P0] node.evmAddress returns derived EVM address
  // -------------------------------------------------------------------------

  it.skip('[P0] node.evmAddress returns EVM address derived from same secp256k1 key', () => {
    // Arrange
    const config: NodeConfig = {
      secretKey,
      connector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
    };

    // Act
    const node = createNode(config);

    // Assert
    // EVM address is 0x-prefixed, 42 chars (20 bytes hex + 0x prefix)
    expect(node.evmAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  // -------------------------------------------------------------------------
  // [P0] node.start() calls setPacketHandler, runs bootstrap, returns StartResult
  // -------------------------------------------------------------------------

  it.skip('[P0] node.start() wires packet handler and returns StartResult', async () => {
    // Arrange
    const freshConnector = new MockEmbeddedConnector();
    const config: NodeConfig = {
      secretKey,
      connector: freshConnector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      // No known peers — bootstrap will complete with 0 peers
      knownPeers: [],
    };
    const node = createNode(config);

    // Act
    const result: StartResult = await node.start();

    // Assert
    // setPacketHandler should have been called on the connector
    expect(freshConnector.packetHandler).not.toBeNull();

    // StartResult contains bootstrap summary
    expect(result).toHaveProperty('peerCount');
    expect(result).toHaveProperty('channelCount');
    expect(result).toHaveProperty('bootstrapResults');
    expect(result.peerCount).toBe(0);
    expect(result.channelCount).toBe(0);
    expect(Array.isArray(result.bootstrapResults)).toBe(true);

    // Cleanup
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // [P0] Double start() throws NodeError
  // -------------------------------------------------------------------------

  it.skip('[P0] calling start() twice throws NodeError', async () => {
    // Arrange
    const freshConnector = new MockEmbeddedConnector();
    const config: NodeConfig = {
      secretKey,
      connector: freshConnector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      knownPeers: [],
    };
    const node = createNode(config);
    await node.start();

    // Act & Assert
    await expect(node.start()).rejects.toThrow(NodeError);
    await expect(node.start()).rejects.toThrow(/already started/i);

    // Cleanup
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // [P1] node.stop() unsubscribes relay monitor and cleans up
  // -------------------------------------------------------------------------

  it.skip('[P1] node.stop() cleans up and is idempotent', async () => {
    // Arrange
    const freshConnector = new MockEmbeddedConnector();
    const config: NodeConfig = {
      secretKey,
      connector: freshConnector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      knownPeers: [],
    };
    const node = createNode(config);
    await node.start();

    // Act
    await node.stop();

    // Assert — calling stop again is a no-op (does not throw)
    await expect(node.stop()).resolves.not.toThrow();

    // After stop, start can be called again (lifecycle reset)
    // This is an implementation detail — adjust if SDK design differs
  });

  // -------------------------------------------------------------------------
  // [P1] Full pipeline: TOON event -> parse -> verify -> price -> dispatch -> accept
  // -------------------------------------------------------------------------

  it.skip('[P1] full pipeline: signed TOON event dispatches to kind handler and accepts', async () => {
    // Arrange
    const eventSecretKey = createTestSecretKey();
    const handlerFn = vi.fn(async (ctx: HandlerContext) => {
      // Handler receives context with raw TOON, kind, pubkey, amount
      expect(ctx.toon).toBeDefined();
      expect(ctx.kind).toBe(1);
      expect(ctx.pubkey).toMatch(/^[0-9a-f]{64}$/);
      expect(ctx.amount).toBeGreaterThan(0n);

      // Lazy decode returns full NostrEvent
      const decoded = ctx.decode();
      expect(decoded.kind).toBe(1);
      expect(decoded.content).toBe('Integration test event');

      return ctx.accept();
    });

    const freshConnector = new MockEmbeddedConnector();
    const basePricePerByte = 10n;

    const config: NodeConfig = {
      secretKey,
      connector: freshConnector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      knownPeers: [],
      basePricePerByte,
      handlers: { 1: handlerFn },
    };
    const node = createNode(config);
    await node.start();

    // Create a real signed TOON event
    const { toonBytes, toonBase64 } = createSignedToonEvent(
      eventSecretKey,
      1,
      'Integration test event'
    );

    // Calculate correct payment amount
    const amount = BigInt(toonBytes.length) * basePricePerByte;

    // Act — deliver the packet to the connector's registered handler
    const response = await freshConnector.deliverPacket({
      amount: amount.toString(),
      destination: 'g.test.node',
      data: toonBase64,
    });

    // Assert
    expect(response.accept).toBe(true);
    expect(handlerFn).toHaveBeenCalledOnce();

    // Cleanup
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // [P1] Pipeline rejects invalid signature with F06
  // -------------------------------------------------------------------------

  it.skip('[P1] pipeline rejects event with invalid signature (F06)', async () => {
    // Arrange
    const handlerFn = vi.fn();
    const freshConnector = new MockEmbeddedConnector();

    const config: NodeConfig = {
      secretKey,
      connector: freshConnector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      knownPeers: [],
      handlers: { 1: handlerFn },
    };
    const node = createNode(config);
    await node.start();

    // Create a valid event, then tamper with the TOON to break the signature
    const eventKey = createTestSecretKey();
    const { toonBytes } = createSignedToonEvent(eventKey, 1, 'Tampered event');

    // Tamper: flip a byte in the content area (past the header fields)
    const tampered = new Uint8Array(toonBytes);
    tampered[tampered.length - 5] = tampered[tampered.length - 5]! ^ 0xff;
    const tamperedBase64 = Buffer.from(tampered).toString('base64');

    const amount = BigInt(toonBytes.length) * 10n;

    // Act
    const response = await freshConnector.deliverPacket({
      amount: amount.toString(),
      destination: 'g.test.node',
      data: tamperedBase64,
    });

    // Assert — rejected with F06 (unexpected payment / bad signature)
    expect(response.accept).toBe(false);
    if (!response.accept) {
      expect(response.code).toBe('F06');
    }
    // Handler should NOT have been invoked
    expect(handlerFn).not.toHaveBeenCalled();

    // Cleanup
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // [P1] Pipeline rejects underpaid event with F04
  // -------------------------------------------------------------------------

  it.skip('[P1] pipeline rejects underpaid event with F04 (insufficient amount)', async () => {
    // Arrange
    const handlerFn = vi.fn();
    const freshConnector = new MockEmbeddedConnector();
    const basePricePerByte = 10n;

    const config: NodeConfig = {
      secretKey,
      connector: freshConnector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      knownPeers: [],
      basePricePerByte,
      handlers: { 1: handlerFn },
    };
    const node = createNode(config);
    await node.start();

    // Create a real signed event
    const eventKey = createTestSecretKey();
    const { toonBytes, toonBase64 } = createSignedToonEvent(
      eventKey,
      1,
      'Underpaid event'
    );

    // Pay only half the required amount
    const requiredAmount = BigInt(toonBytes.length) * basePricePerByte;
    const underpaidAmount = requiredAmount / 2n;

    // Act
    const response = await freshConnector.deliverPacket({
      amount: underpaidAmount.toString(),
      destination: 'g.test.node',
      data: toonBase64,
    });

    // Assert — rejected with F04 (insufficient amount)
    expect(response.accept).toBe(false);
    if (!response.accept) {
      expect(response.code).toBe('F04');
      // Metadata should include required vs received
      expect(response.metadata).toBeDefined();
      expect(response.metadata?.required).toBe(requiredAmount.toString());
      expect(response.metadata?.received).toBe(underpaidAmount.toString());
    }
    // Handler should NOT have been invoked
    expect(handlerFn).not.toHaveBeenCalled();

    // Cleanup
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // [P1] Self-write bypass: node's own pubkey events skip pricing
  // -------------------------------------------------------------------------

  it.skip('[P1] self-write bypass: events from node own pubkey skip pricing validation', async () => {
    // Arrange
    const handlerFn = vi.fn(async (ctx: HandlerContext) => ctx.accept());
    const freshConnector = new MockEmbeddedConnector();
    const basePricePerByte = 10n;

    const config: NodeConfig = {
      secretKey,
      connector: freshConnector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      knownPeers: [],
      basePricePerByte,
      handlers: { 1: handlerFn },
    };
    const node = createNode(config);
    await node.start();

    // Create a signed event from the NODE'S OWN secretKey
    const { toonBase64 } = createSignedToonEvent(
      secretKey,
      1,
      'Self-write event'
    );

    // Act — send with 0 amount (should be accepted due to self-write bypass)
    const response = await freshConnector.deliverPacket({
      amount: '0',
      destination: 'g.test.node',
      data: toonBase64,
    });

    // Assert — accepted despite 0 payment
    expect(response.accept).toBe(true);
    expect(handlerFn).toHaveBeenCalledOnce();

    // Cleanup
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // [P2] No matching handler returns F00 (bad request)
  // -------------------------------------------------------------------------

  it.skip('[P2] event with unregistered kind and no default handler returns F00', async () => {
    // Arrange
    const freshConnector = new MockEmbeddedConnector();
    const basePricePerByte = 10n;

    // Register handler for kind 1 only, no default handler
    const config: NodeConfig = {
      secretKey,
      connector: freshConnector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      knownPeers: [],
      basePricePerByte,
      handlers: { 1: vi.fn() },
    };
    const node = createNode(config);
    await node.start();

    // Create a kind:30617 event (not registered)
    const eventKey = createTestSecretKey();
    const { toonBytes, toonBase64 } = createSignedToonEvent(
      eventKey,
      30617,
      'Unhandled kind'
    );
    const amount = BigInt(toonBytes.length) * basePricePerByte;

    // Act
    const response = await freshConnector.deliverPacket({
      amount: amount.toString(),
      destination: 'g.test.node',
      data: toonBase64,
    });

    // Assert — rejected with F00 (bad request / no handler)
    expect(response.accept).toBe(false);
    if (!response.accept) {
      expect(response.code).toBe('F00');
    }

    // Cleanup
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // [P2] Default handler catches unmatched kinds
  // -------------------------------------------------------------------------

  it.skip('[P2] onDefault handler receives events with no kind-specific handler', async () => {
    // Arrange
    const defaultHandler = vi.fn(async (ctx: HandlerContext) => ctx.accept());
    const freshConnector = new MockEmbeddedConnector();
    const basePricePerByte = 10n;

    const config: NodeConfig = {
      secretKey,
      connector: freshConnector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      knownPeers: [],
      basePricePerByte,
      handlers: {},
      defaultHandler,
    };
    const node = createNode(config);
    await node.start();

    // Create a kind:42 event (no specific handler)
    const eventKey = createTestSecretKey();
    const { toonBytes, toonBase64 } = createSignedToonEvent(
      eventKey,
      42,
      'Default handler test'
    );
    const amount = BigInt(toonBytes.length) * basePricePerByte;

    // Act
    const response = await freshConnector.deliverPacket({
      amount: amount.toString(),
      destination: 'g.test.node',
      data: toonBase64,
    });

    // Assert
    expect(response.accept).toBe(true);
    expect(defaultHandler).toHaveBeenCalledOnce();

    // Cleanup
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // [P2] Handler exception produces T00 (internal error)
  // -------------------------------------------------------------------------

  it.skip('[P2] handler throwing unhandled exception returns T00 (internal error)', async () => {
    // Arrange
    const failingHandler = vi.fn(async () => {
      throw new Error('Handler crashed');
    });
    const freshConnector = new MockEmbeddedConnector();
    const basePricePerByte = 10n;

    const config: NodeConfig = {
      secretKey,
      connector: freshConnector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      knownPeers: [],
      basePricePerByte,
      handlers: { 1: failingHandler },
    };
    const node = createNode(config);
    await node.start();

    const eventKey = createTestSecretKey();
    const { toonBytes, toonBase64 } = createSignedToonEvent(
      eventKey,
      1,
      'Crash test'
    );
    const amount = BigInt(toonBytes.length) * basePricePerByte;

    // Act
    const response = await freshConnector.deliverPacket({
      amount: amount.toString(),
      destination: 'g.test.node',
      data: toonBase64,
    });

    // Assert — T00 internal error
    expect(response.accept).toBe(false);
    if (!response.accept) {
      expect(response.code).toBe('T00');
    }
    expect(failingHandler).toHaveBeenCalledOnce();

    // Cleanup
    await node.stop();
  });
});

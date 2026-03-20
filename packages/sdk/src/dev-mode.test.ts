/**
 * ATDD tests for Story 1.10 -- dev mode verification and pricing bypass
 *
 * Tests that devMode=true skips signature verification, bypasses pricing,
 * and logs packet details. Also validates that production mode (devMode unset)
 * enforces verification and pricing normally (Risk E1-R15).
 *
 * Uses createNode() with a MockConnector to exercise the full pipeline,
 * matching the integration test pattern from create-node.test.ts.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { generateSecretKey, finalizeEvent } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';

import { createNode } from './create-node.js';
import type { NodeConfig } from './create-node.js';
import type { HandlerContext } from './handler-context.js';

import type {
  HandlePacketRequest,
  HandlePacketResponse,
  EmbeddableConnectorLike,
} from '@toon-protocol/core';
import type { SendPacketParams, SendPacketResult } from '@toon-protocol/core';
import type { RegisterPeerParams } from '@toon-protocol/core';

import {
  encodeEventToToon,
  decodeEventFromToon,
} from '@toon-protocol/core/toon';

// ---------------------------------------------------------------------------
// Mock Embedded Connector (same pattern as create-node.test.ts)
// ---------------------------------------------------------------------------

interface MockConnector extends EmbeddableConnectorLike {
  deliverPacket(req: HandlePacketRequest): Promise<HandlePacketResponse>;
}

function createMockConnector(): MockConnector {
  let packetHandler:
    | ((
        req: HandlePacketRequest
      ) => HandlePacketResponse | Promise<HandlePacketResponse>)
    | null = null;

  return {
    async sendPacket(_params: SendPacketParams): Promise<SendPacketResult> {
      return { type: 'reject', code: 'F02', message: 'No route' };
    },
    async registerPeer(_params: RegisterPeerParams): Promise<void> {},
    async removePeer(_peerId: string): Promise<void> {},
    setPacketHandler(
      handler: (
        req: HandlePacketRequest
      ) => HandlePacketResponse | Promise<HandlePacketResponse>
    ): void {
      packetHandler = handler;
    },
    async deliverPacket(
      req: HandlePacketRequest
    ): Promise<HandlePacketResponse> {
      if (!packetHandler) {
        throw new Error(
          'No packet handler registered -- call node.start() first'
        );
      }
      return packetHandler(req);
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

describe('Dev Mode', () => {
  let nodeSecretKey: Uint8Array;
  let eventSecretKey: Uint8Array;
  const basePricePerByte = 10n;

  beforeAll(() => {
    nodeSecretKey = generateSecretKey();
    eventSecretKey = generateSecretKey();
  });

  // -------------------------------------------------------------------------
  // T-1.10-01: devMode=true: invalid signature accepted
  // -------------------------------------------------------------------------

  it('[P1] devMode skips signature verification for invalid signatures', async () => {
    // Arrange
    const handlerFn = vi.fn(async (ctx: HandlerContext) => ctx.accept());
    const connector = createMockConnector();

    const config: NodeConfig = {
      secretKey: nodeSecretKey,
      connector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      knownPeers: [],
      basePricePerByte,
      devMode: true,
      handlers: { 1: handlerFn },
    };
    const node = createNode(config);
    await node.start();

    // Create a valid signed event, then re-encode with a corrupted signature.
    // This preserves the TOON structure (so shallow parse succeeds) but the
    // Schnorr signature is invalid (so verification would fail in production).
    const { event } = createSignedToonEvent(
      eventSecretKey,
      1,
      'Tampered dev event'
    );
    const badSigEvent = {
      ...event,
      sig: 'ff'.repeat(32) + '00'.repeat(32), // 64-byte hex, structurally valid but wrong
    } as NostrEvent;
    const badSigToonBytes = encodeEventToToon(badSigEvent);
    const badSigBase64 = Buffer.from(badSigToonBytes).toString('base64');

    // Act -- deliver packet with invalid signature through pipeline
    const response = await connector.deliverPacket({
      amount: '0',
      destination: 'g.test.dev',
      data: badSigBase64,
    });

    // Assert -- in dev mode, invalid signatures are accepted
    expect(response.accept).toBe(true);
    expect(handlerFn).toHaveBeenCalled();

    // Cleanup
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // T-1.10-03: devMode=true: packet details logged
  // -------------------------------------------------------------------------

  it('[P2] devMode logs incoming packets to console', async () => {
    // Arrange
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const handlerFn = vi.fn(async (ctx: HandlerContext) => ctx.accept());
    const connector = createMockConnector();

    const config: NodeConfig = {
      secretKey: nodeSecretKey,
      connector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      knownPeers: [],
      basePricePerByte,
      devMode: true,
      handlers: { 1: handlerFn },
    };
    const node = createNode(config);
    await node.start();

    // Create a valid signed event
    const { toonBase64 } = createSignedToonEvent(
      eventSecretKey,
      1,
      'Logging test event'
    );

    try {
      // Act
      await connector.deliverPacket({
        amount: '0',
        destination: 'g.test.dev',
        data: toonBase64,
      });

      // Assert -- console.log was called with [toon:dev] prefix and packet details
      expect(consoleSpy).toHaveBeenCalled();
      const logCalls = consoleSpy.mock.calls.flat().join(' ');
      expect(logCalls).toContain('[toon:dev]');
      expect(logCalls).toContain('kind=');
      expect(logCalls).toContain('pubkey=');
      expect(logCalls).toContain('amount=');
      expect(logCalls).toContain('dest=g.test.dev');
      expect(logCalls).toContain('toon=');
    } finally {
      // Cleanup -- restore console.log even if assertions fail
      consoleSpy.mockRestore();
      await node.stop();
    }
  });

  // -------------------------------------------------------------------------
  // T-1.10-02: devMode=true: underpaid event accepted (pricing bypass)
  // -------------------------------------------------------------------------

  it('[P1] devMode bypasses pricing validation (zero payment accepted)', async () => {
    // Arrange
    const handlerFn = vi.fn(async (ctx: HandlerContext) => ctx.accept());
    const connector = createMockConnector();

    const config: NodeConfig = {
      secretKey: nodeSecretKey,
      connector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      knownPeers: [],
      basePricePerByte,
      devMode: true,
      handlers: { 1: handlerFn },
    };
    const node = createNode(config);
    await node.start();

    // Create a valid signed event with non-trivial data
    const { toonBase64 } = createSignedToonEvent(
      eventSecretKey,
      1,
      'Zero payment dev event'
    );

    // Act -- send with zero payment (would fail pricing in production)
    const response = await connector.deliverPacket({
      amount: '0',
      destination: 'g.test.dev',
      data: toonBase64,
    });

    // Assert -- accepted despite zero payment
    expect(response.accept).toBe(true);
    expect(handlerFn).toHaveBeenCalled();

    // Cleanup
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // T-1.10-04: devMode not set: verification and pricing active (no leak)
  // -------------------------------------------------------------------------

  it('[P0] production mode rejects invalid signature with F06', async () => {
    // Arrange -- no devMode set (defaults to false)
    const handlerFn = vi.fn();
    const connector = createMockConnector();

    const config: NodeConfig = {
      secretKey: nodeSecretKey,
      connector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      knownPeers: [],
      basePricePerByte,
      // NOTE: devMode intentionally omitted to test default (false)
      handlers: { 1: handlerFn },
    };
    const node = createNode(config);
    await node.start();

    // Create a valid signed event, then re-encode with a corrupted signature.
    // TOON structure is valid (shallow parse succeeds) but signature is wrong.
    const { event } = createSignedToonEvent(
      eventSecretKey,
      1,
      'Production sig test'
    );
    const badSigEvent = {
      ...event,
      sig: 'ff'.repeat(32) + '00'.repeat(32),
    } as NostrEvent;
    const badSigToonBytes = encodeEventToToon(badSigEvent);
    const badSigBase64 = Buffer.from(badSigToonBytes).toString('base64');
    const amount = BigInt(badSigToonBytes.length) * basePricePerByte;

    // Act
    const response = await connector.deliverPacket({
      amount: amount.toString(),
      destination: 'g.test.prod',
      data: badSigBase64,
    });

    // Assert -- in production, invalid signatures are rejected with F06
    expect(response.accept).toBe(false);
    if (!response.accept) {
      expect(response.code).toBe('F06');
    }
    expect(handlerFn).not.toHaveBeenCalled();

    // Cleanup
    await node.stop();
  });

  it('[P1] devMode accepts events with invalid (non-numeric) amount string', async () => {
    // Arrange -- dev mode with invalid amount string triggers BigInt fallback to 0n
    const handlerFn = vi.fn(async (ctx: HandlerContext) => ctx.accept());
    const connector = createMockConnector();

    const config: NodeConfig = {
      secretKey: nodeSecretKey,
      connector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      knownPeers: [],
      basePricePerByte,
      devMode: true,
      handlers: { 1: handlerFn },
    };
    const node = createNode(config);
    await node.start();

    // Create a valid signed event
    const { toonBase64 } = createSignedToonEvent(
      eventSecretKey,
      1,
      'Invalid amount dev event'
    );

    // Act -- send with a non-numeric amount (BigInt() would throw)
    const response = await connector.deliverPacket({
      amount: 'not-a-number',
      destination: 'g.test.dev',
      data: toonBase64,
    });

    // Assert -- in dev mode, invalid amount falls back to 0n and event is accepted
    expect(response.accept).toBe(true);
    expect(handlerFn).toHaveBeenCalled();

    // Cleanup
    await node.stop();
  });

  it('[P0] production mode rejects invalid (non-numeric) amount with T00', async () => {
    // Arrange -- no devMode set (defaults to false)
    const handlerFn = vi.fn();
    const connector = createMockConnector();

    const config: NodeConfig = {
      secretKey: nodeSecretKey,
      connector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      knownPeers: [],
      basePricePerByte,
      // NOTE: devMode intentionally omitted to test default (false)
      handlers: { 1: handlerFn },
    };
    const node = createNode(config);
    await node.start();

    // Create a validly-signed event
    const { toonBase64 } = createSignedToonEvent(
      eventSecretKey,
      1,
      'Production amount test'
    );

    // Act -- send with a non-numeric amount string
    const response = await connector.deliverPacket({
      amount: 'garbage',
      destination: 'g.test.prod',
      data: toonBase64,
    });

    // Assert -- in production, invalid amount string is rejected with T00
    expect(response.accept).toBe(false);
    if (!response.accept) {
      expect(response.code).toBe('T00');
    }
    expect(handlerFn).not.toHaveBeenCalled();

    // Cleanup
    await node.stop();
  });

  it('[P0] production mode does not log packets with [toon:dev] prefix', async () => {
    // Arrange -- no devMode set (defaults to false)
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const handlerFn = vi.fn(async (ctx: HandlerContext) => ctx.accept());
    const connector = createMockConnector();

    const config: NodeConfig = {
      secretKey: nodeSecretKey,
      connector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      knownPeers: [],
      basePricePerByte,
      // NOTE: devMode intentionally omitted to test default (false)
      handlers: { 1: handlerFn },
    };
    const node = createNode(config);
    await node.start();

    // Create a validly-signed event with correct payment
    const { toonBytes, toonBase64 } = createSignedToonEvent(
      eventSecretKey,
      1,
      'Production no-log test'
    );
    const amount = BigInt(toonBytes.length) * basePricePerByte;

    try {
      // Act
      await connector.deliverPacket({
        amount: amount.toString(),
        destination: 'g.test.prod',
        data: toonBase64,
      });

      // Assert -- event was accepted (proves full pipeline ran, not just early reject)
      expect(handlerFn).toHaveBeenCalled();

      // Assert -- no [toon:dev] log in production mode
      const logCalls = consoleSpy.mock.calls.flat().join(' ');
      expect(logCalls).not.toContain('[toon:dev]');
    } finally {
      // Cleanup -- restore console.log even if assertions fail
      consoleSpy.mockRestore();
      await node.stop();
    }
  });

  it('[P0] production mode rejects underpaid event with F04', async () => {
    // Arrange -- no devMode set (defaults to false)
    const handlerFn = vi.fn();
    const connector = createMockConnector();

    const config: NodeConfig = {
      secretKey: nodeSecretKey,
      connector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      knownPeers: [],
      basePricePerByte,
      // NOTE: devMode intentionally omitted to test default (false)
      handlers: { 1: handlerFn },
    };
    const node = createNode(config);
    await node.start();

    // Create a validly-signed event but send with insufficient payment
    const { toonBytes, toonBase64 } = createSignedToonEvent(
      eventSecretKey,
      1,
      'Production pricing test'
    );
    const requiredAmount = BigInt(toonBytes.length) * basePricePerByte;
    const underpaidAmount = requiredAmount / 2n;

    // Act
    const response = await connector.deliverPacket({
      amount: underpaidAmount.toString(),
      destination: 'g.test.prod',
      data: toonBase64,
    });

    // Assert -- in production, underpaid events are rejected with F04
    expect(response.accept).toBe(false);
    if (!response.accept) {
      expect(response.code).toBe('F04');
    }
    expect(handlerFn).not.toHaveBeenCalled();

    // Cleanup
    await node.stop();
  });
});

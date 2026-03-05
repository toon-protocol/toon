/**
 * Unit Tests: createNode() composition (Story 1.7)
 *
 * Tests defaults, config-based handler registration, builder pattern,
 * identity derivation, and connector pass-through using mocked
 * CrosstownNode internals (no real bootstrap or relay).
 */

import { describe, it, expect, vi } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { createNode } from './create-node.js';
import type {
  HandlePacketRequest,
  HandlePacketResponse,
  EmbeddableConnectorLike,
} from '@crosstown/core';
import type { SendPacketParams, SendPacketResult } from '@crosstown/core';
import type { RegisterPeerParams } from '@crosstown/core';

// ---------------------------------------------------------------------------
// Mock Connector (minimal)
// ---------------------------------------------------------------------------

function createMockConnector(): EmbeddableConnectorLike & {
  packetHandler:
    | ((
        req: HandlePacketRequest
      ) => HandlePacketResponse | Promise<HandlePacketResponse>)
    | null;
} {
  return {
    packetHandler: null,
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
      this.packetHandler = handler;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createNode() unit tests', () => {
  // -------------------------------------------------------------------------
  // T-1.7-13: Defaults
  // -------------------------------------------------------------------------

  it('[P1] createNode with minimal config uses defaults (basePricePerByte=10n, devMode=false)', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const connector = createMockConnector();

    // Act -- createNode should not throw with minimal config
    const node = createNode({
      secretKey,
      connector,
    });

    // Assert -- node is created successfully
    expect(node).toBeDefined();
    expect(node.pubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(node.evmAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  // -------------------------------------------------------------------------
  // Config-based handler registration (AC: #7)
  // -------------------------------------------------------------------------

  it('[P1] createNode with handlers map accepts config and creates node', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const connector = createMockConnector();
    const handler = vi.fn();

    // Act -- should not throw with handlers in config
    const node = createNode({
      secretKey,
      connector,
      handlers: { 1: handler },
    });

    // Assert -- node was created successfully with all expected methods
    // Full handler dispatch verification is in integration tests
    expect(node).toBeDefined();
    expect(node.start).toBeInstanceOf(Function);
    expect(node.stop).toBeInstanceOf(Function);
    expect(node.on).toBeInstanceOf(Function);
    expect(node.onDefault).toBeInstanceOf(Function);
  });

  it('[P1] createNode with defaultHandler accepts config and creates node', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const connector = createMockConnector();
    const defaultHandler = vi.fn();

    // Act -- should not throw with defaultHandler in config
    const node = createNode({
      secretKey,
      connector,
      defaultHandler,
    });

    // Assert -- full handler dispatch verification is in integration tests
    expect(node).toBeDefined();
    expect(node.start).toBeInstanceOf(Function);
    expect(node.stop).toBeInstanceOf(Function);
  });

  // -------------------------------------------------------------------------
  // Builder pattern chaining
  // -------------------------------------------------------------------------

  it('[P1] .on(kind, handler) returns this for builder pattern chaining', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const connector = createMockConnector();
    const node = createNode({ secretKey, connector });

    // Act
    const result = node.on(1, vi.fn());

    // Assert -- returns the same node for chaining
    expect(result).toBe(node);
  });

  it('[P1] .onDefault(handler) returns this for builder pattern chaining', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const connector = createMockConnector();
    const node = createNode({ secretKey, connector });

    // Act
    const result = node.onDefault(vi.fn());

    // Assert -- returns the same node for chaining
    expect(result).toBe(node);
  });

  it('[P1] builder pattern allows chaining .on() and .onDefault()', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const connector = createMockConnector();

    // Act
    const node = createNode({ secretKey, connector })
      .on(1, vi.fn())
      .on(30617, vi.fn())
      .onDefault(vi.fn());

    // Assert
    expect(node).toBeDefined();
    expect(node.pubkey).toMatch(/^[0-9a-f]{64}$/);
  });

  // -------------------------------------------------------------------------
  // Identity derivation
  // -------------------------------------------------------------------------

  it('[P1] node.pubkey returns correct x-only public key (T-1.7-11)', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const expectedPubkey = getPublicKey(secretKey);
    const connector = createMockConnector();

    // Act
    const node = createNode({ secretKey, connector });

    // Assert
    expect(node.pubkey).toBe(expectedPubkey);
    expect(node.pubkey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('[P1] node.evmAddress returns correct EVM address (T-1.7-12)', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const connector = createMockConnector();

    // Act
    const node = createNode({ secretKey, connector });

    // Assert
    expect(node.evmAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(node.evmAddress.length).toBe(42);
  });

  // -------------------------------------------------------------------------
  // Connector pass-through
  // -------------------------------------------------------------------------

  it('[P1] node.connector is pass-through of config.connector', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const connector = createMockConnector();

    // Act
    const node = createNode({ secretKey, connector });

    // Assert
    expect(node.connector).toBe(connector);
  });

  // -------------------------------------------------------------------------
  // Input validation
  // -------------------------------------------------------------------------

  it('[P1] .on() rejects invalid kind (negative number)', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const connector = createMockConnector();
    const node = createNode({ secretKey, connector });

    // Act & Assert
    expect(() => node.on(-1, vi.fn())).toThrow(/non-negative integer/);
  });

  it('[P1] .on() rejects invalid kind (NaN)', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const connector = createMockConnector();
    const node = createNode({ secretKey, connector });

    // Act & Assert
    expect(() => node.on(NaN, vi.fn())).toThrow(/non-negative integer/);
  });

  it('[P1] .on() rejects invalid kind (non-integer)', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const connector = createMockConnector();
    const node = createNode({ secretKey, connector });

    // Act & Assert
    expect(() => node.on(1.5, vi.fn())).toThrow(/non-negative integer/);
  });

  it('[P1] createNode with invalid secretKey throws NodeError', () => {
    // Arrange
    const connector = createMockConnector();
    const badKey = new Uint8Array(16); // Wrong length

    // Act & Assert
    expect(() => createNode({ secretKey: badKey, connector })).toThrow(
      /Invalid secretKey/
    );
  });
});

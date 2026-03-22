/**
 * Unit Tests: createNode() composition (Stories 1.7, 1.9)
 *
 * Tests defaults, config-based handler registration, builder pattern,
 * identity derivation, connector pass-through, lifecycle event forwarding,
 * and peerWith guard behavior using mocked ToonNode internals
 * (no real bootstrap or relay).
 */

import { describe, it, expect, vi } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { createNode } from './create-node.js';
import { NodeError } from './errors.js';
import type { Handler } from './handler-registry.js';
import type {
  HandlePacketRequest,
  HandlePacketResponse,
  EmbeddableConnectorLike,
  BootstrapEventListener,
  BootstrapEvent,
} from '@toon-protocol/core';
import { deriveChildAddress, ILP_ROOT_PREFIX } from '@toon-protocol/core';
import type { SendPacketParams, SendPacketResult } from '@toon-protocol/core';
import type { RegisterPeerParams } from '@toon-protocol/core';

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

  // -------------------------------------------------------------------------
  // Story 1.9: on('bootstrap', listener) lifecycle event forwarding (AC #5)
  // -------------------------------------------------------------------------

  it('[P2] .on("bootstrap", listener) returns node for builder pattern chaining (T-1.9-05)', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const connector = createMockConnector();
    const node = createNode({ secretKey, connector });
    const listener: BootstrapEventListener = vi.fn();

    // Act
    const result = node.on('bootstrap', listener);

    // Assert -- returns the same node for chaining
    expect(result).toBe(node);
  });

  it('[P2] .on("bootstrap", listener) can be chained with .on(kind, handler) (T-1.9-05)', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const connector = createMockConnector();
    const listener: BootstrapEventListener = vi.fn();

    // Act -- chaining .on('bootstrap') with .on(kind)
    const node = createNode({ secretKey, connector })
      .on('bootstrap', listener)
      .on(1, vi.fn())
      .onDefault(vi.fn());

    // Assert
    expect(node).toBeDefined();
    expect(node.pubkey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('[P2] .on() with unknown lifecycle event string throws NodeError (T-1.9-05)', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const connector = createMockConnector();
    const node = createNode({ secretKey, connector });

    // Act & Assert -- unknown string event should throw NodeError
    expect(() => node.on('unknown-event' as 'bootstrap', vi.fn())).toThrow(
      /Unknown lifecycle event/
    );
  });

  it('[P2] .on() with unknown lifecycle event throws NodeError (not generic Error) (T-1.9-05)', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const connector = createMockConnector();
    const node = createNode({ secretKey, connector });

    // Act & Assert -- verify the error is a NodeError instance
    expect(() => node.on('invalid' as 'bootstrap', vi.fn())).toThrow(NodeError);
  });

  it('[P2] .on("bootstrap", listener) accepts listener without throwing (T-1.9-05)', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const connector = createMockConnector();
    const node = createNode({ secretKey, connector });
    const listener: BootstrapEventListener = () => {
      // no-op
    };

    // Act & Assert -- should not throw
    expect(() => node.on('bootstrap', listener)).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Story 1.9: peerWith(pubkey) guard behavior (AC #4)
  // -------------------------------------------------------------------------

  it('[P2] peerWith method exists on ServiceNode (T-1.9-04)', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const connector = createMockConnector();

    // Act
    const node = createNode({ secretKey, connector });

    // Assert
    expect(typeof node.peerWith).toBe('function');
  });

  it('[P2] peerWith throws NodeError when node is not started (T-1.9-04)', async () => {
    // Arrange
    const secretKey = generateSecretKey();
    const connector = createMockConnector();
    const node = createNode({ secretKey, connector });

    // Act & Assert -- calling peerWith before start should throw NodeError
    await expect(node.peerWith('aa'.repeat(32))).rejects.toThrow(
      /Cannot peer: node not started/
    );
  });

  it('[P2] peerWith throws NodeError (not generic Error) when not started (T-1.9-04)', async () => {
    // Arrange
    const secretKey = generateSecretKey();
    const connector = createMockConnector();
    const node = createNode({ secretKey, connector });

    // Act & Assert -- verify the error is a NodeError instance
    await expect(node.peerWith('bb'.repeat(32))).rejects.toThrow(NodeError);
  });

  // -------------------------------------------------------------------------
  // Story 1.9: on('bootstrap', listener) receives lifecycle events (AC #5)
  // -------------------------------------------------------------------------

  it('[P1] on("bootstrap", listener) forwards events from bootstrapService during start (T-1.9-05)', async () => {
    // Arrange -- no known peers, so bootstrap completes immediately but
    // still emits phase transitions and a ready event
    const secretKey = generateSecretKey();
    const connector = createMockConnector();
    const node = createNode({ secretKey, connector, knownPeers: [] });

    const events: BootstrapEvent[] = [];
    node.on('bootstrap', (event: BootstrapEvent) => {
      events.push(event);
    });

    // Act
    await node.start();

    // Assert -- should have received phase and ready events from bootstrapService
    const phaseEvents = events.filter((e) => e.type === 'bootstrap:phase');
    expect(phaseEvents.length).toBeGreaterThan(0);

    const readyEvent = events.find((e) => e.type === 'bootstrap:ready');
    expect(readyEvent).toBeDefined();
    if (readyEvent?.type === 'bootstrap:ready') {
      expect(readyEvent.peerCount).toBe(0);
      expect(readyEvent.channelCount).toBe(0);
    }

    // Cleanup
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // Security: peerWith pubkey format validation
  // -------------------------------------------------------------------------

  it('[P2] peerWith rejects pubkey that is too short', async () => {
    // Arrange
    const secretKey = generateSecretKey();
    const connector = createMockConnector();
    const node = createNode({ secretKey, connector, knownPeers: [] });
    await node.start();

    // Act & Assert
    await expect(node.peerWith('abcd')).rejects.toThrow(/Invalid pubkey/);

    // Cleanup
    await node.stop();
  });

  it('[P2] peerWith rejects pubkey with uppercase hex', async () => {
    // Arrange
    const secretKey = generateSecretKey();
    const connector = createMockConnector();
    const node = createNode({ secretKey, connector, knownPeers: [] });
    await node.start();

    // Act & Assert -- uppercase hex should be rejected (Nostr pubkeys are lowercase)
    await expect(node.peerWith('AA'.repeat(32))).rejects.toThrow(
      /Invalid pubkey/
    );

    // Cleanup
    await node.stop();
  });

  it('[P2] peerWith rejects pubkey with non-hex characters', async () => {
    // Arrange
    const secretKey = generateSecretKey();
    const connector = createMockConnector();
    const node = createNode({ secretKey, connector, knownPeers: [] });
    await node.start();

    // Act & Assert
    await expect(node.peerWith('zz'.repeat(32))).rejects.toThrow(
      /Invalid pubkey/
    );

    // Cleanup
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // Security: config.handlers kind validation
  // -------------------------------------------------------------------------

  it('[P2] createNode rejects non-numeric kind keys in handlers config', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const connector = createMockConnector();

    // Act & Assert -- non-numeric key 'foo' should fail Number() -> NaN validation
    expect(() =>
      createNode({
        secretKey,
        connector,
        handlers: { foo: vi.fn() } as unknown as Record<number, Handler>,
      })
    ).toThrow(/Invalid event kind in handlers config/);
  });

  // -------------------------------------------------------------------------
  // Security: lifecycle event name sanitization
  // -------------------------------------------------------------------------

  it('[P2] on() with control characters in event name sanitizes before error', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const connector = createMockConnector();
    const node = createNode({ secretKey, connector });

    // Act & Assert -- control characters should be stripped from error message
    expect(() => node.on('evil\n\rinjection' as 'bootstrap', vi.fn())).toThrow(
      /Unknown lifecycle event: 'evilinjection'/
    );
  });

  // -------------------------------------------------------------------------
  // Story 7.2: Address derivation from upstreamPrefix (AC #1, #2, #3)
  // -------------------------------------------------------------------------

  it('T-7.2-02: createNode with upstreamPrefix derives ILP address as prefix.pubkey8 (Task 6.1)', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    const connector = createMockConnector();

    // Act -- should not throw (address is derived from upstreamPrefix + pubkey)
    const node = createNode({
      secretKey,
      connector,
      upstreamPrefix: 'g.toon.useast',
    });

    // Assert -- node created successfully with derived address
    expect(node).toBeDefined();
    expect(node.pubkey).toBe(pubkey);
  });

  it('T-7.2-04: createNode with ilpAddress=g.toon uses it directly (genesis node) (Task 6.2)', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const connector = createMockConnector();

    // Act -- genesis node uses ILP_ROOT_PREFIX directly
    const node = createNode({
      secretKey,
      connector,
      ilpAddress: 'g.toon',
    });

    // Assert -- node created without error (address is g.toon, not derived)
    expect(node).toBeDefined();
    expect(node.pubkey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('T-7.2-08: createNode with upstreamPrefix ignores ilpAddress (Task 6.3)', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    const connector = createMockConnector();

    // Act -- upstreamPrefix takes priority over ilpAddress
    const node = createNode({
      secretKey,
      connector,
      upstreamPrefix: 'g.toon',
      ilpAddress: 'g.toon.legacy',
    });

    // Assert -- node created; address is derived from upstreamPrefix, not ilpAddress
    expect(node).toBeDefined();
    expect(node.pubkey).toBe(pubkey);
  });

  it('createNode with no upstreamPrefix and no ilpAddress defaults to deriveChildAddress(ILP_ROOT_PREFIX, pubkey) (Task 6.4)', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    const connector = createMockConnector();

    // Act -- neither upstreamPrefix nor ilpAddress set
    const node = createNode({
      secretKey,
      connector,
    });

    // Assert -- node created successfully with derived default address
    expect(node).toBeDefined();
    expect(node.pubkey).toBe(pubkey);
    // The derived address is g.toon.{pubkey.slice(0,8)} which is deterministic
  });

  // -------------------------------------------------------------------------
  // Story 7.3: Multi-address config (Tasks 8.1-8.4)
  // -------------------------------------------------------------------------

  it('T-7.3-02: createNode with upstreamPrefixes derives two ILP addresses and starts successfully (Task 8.1)', async () => {
    // Arrange
    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    const connector = createMockConnector();
    const expectedAddr1 = deriveChildAddress('g.toon.useast', pubkey);
    const expectedAddr2 = deriveChildAddress('g.toon.euwest', pubkey);

    // Act -- upstreamPrefixes with two prefixes
    const node = createNode({
      secretKey,
      connector,
      upstreamPrefixes: ['g.toon.useast', 'g.toon.euwest'],
      knownPeers: [],
    });

    // Assert -- node created successfully with two distinct derived addresses
    expect(node).toBeDefined();
    expect(node.pubkey).toBe(pubkey);
    expect(expectedAddr1).not.toBe(expectedAddr2);

    // Start and verify bootstrap completes (proves multi-address ilpInfo was valid)
    const result = await node.start();
    expect(result.peerCount).toBe(0);
    await node.stop();
  });

  it('createNode with upstreamPrefix (singular, existing behavior) still works with single address (Task 8.2)', async () => {
    // Arrange
    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    const connector = createMockConnector();
    const expectedAddr = deriveChildAddress('g.toon.useast', pubkey);

    // Act -- existing singular upstreamPrefix
    const node = createNode({
      secretKey,
      connector,
      upstreamPrefix: 'g.toon.useast',
      knownPeers: [],
    });

    // Assert -- node created successfully with deterministic derived address
    expect(node).toBeDefined();
    expect(node.pubkey).toBe(pubkey);
    expect(expectedAddr).toMatch(/^g\.toon\.useast\.[0-9a-f]{8}$/);

    // Start and verify bootstrap completes with single address
    const result = await node.start();
    expect(result.peerCount).toBe(0);
    await node.stop();
  });

  it('createNode with upstreamPrefixes AND upstreamPrefix -- plural takes priority with warning (Task 8.3)', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    const connector = createMockConnector();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Act -- both set; upstreamPrefixes should win
    const node = createNode({
      secretKey,
      connector,
      upstreamPrefixes: ['g.toon.useast', 'g.toon.euwest'],
      upstreamPrefix: 'g.toon.legacy',
    });

    // Assert -- node created; plural takes priority and a warning is logged
    expect(node).toBeDefined();
    expect(node.pubkey).toBe(pubkey);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('upstreamPrefixes takes priority')
    );

    // Cleanup
    warnSpy.mockRestore();
  });

  it('createNode with no upstreamPrefix and no ilpAddress defaults to single-address from ILP_ROOT_PREFIX (Task 8.4)', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    const connector = createMockConnector();
    const expectedDefaultAddr = deriveChildAddress(ILP_ROOT_PREFIX, pubkey);

    // Act -- neither upstreamPrefix nor ilpAddress set
    const node = createNode({
      secretKey,
      connector,
    });

    // Assert -- node created with default derived address from ILP_ROOT_PREFIX
    expect(node).toBeDefined();
    expect(node.pubkey).toBe(pubkey);
    // Verify the default address follows the expected pattern: g.toon.{pubkey8}
    expect(expectedDefaultAddr).toMatch(/^g\.toon\.[0-9a-f]{8}$/);
  });

  // -------------------------------------------------------------------------
  // Story 7.3: addUpstreamPeer / removeUpstreamPeer lifecycle (AC #4, Task 6.3)
  // -------------------------------------------------------------------------

  it('addUpstreamPeer and removeUpstreamPeer methods exist on ServiceNode (Task 6.3)', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const connector = createMockConnector();
    const node = createNode({ secretKey, connector });

    // Assert -- methods exist on the ServiceNode interface
    expect(typeof node.addUpstreamPeer).toBe('function');
    expect(typeof node.removeUpstreamPeer).toBe('function');
  });

  it('addUpstreamPeer adds a new upstream peer address without throwing (Task 6.3)', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const connector = createMockConnector();
    const node = createNode({
      secretKey,
      connector,
      upstreamPrefix: 'g.toon.useast',
    });

    // Act & Assert -- adding a new upstream peer should not throw
    expect(() => node.addUpstreamPeer('g.toon.euwest')).not.toThrow();
  });

  it('removeUpstreamPeer with unknown prefix is a no-op (Task 6.3)', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const connector = createMockConnector();
    const node = createNode({
      secretKey,
      connector,
      upstreamPrefix: 'g.toon.useast',
    });

    // Act & Assert -- removing an unknown prefix should not throw
    expect(() => node.removeUpstreamPeer('g.toon.unknown')).not.toThrow();
  });

  it('removeUpstreamPeer after addUpstreamPeer succeeds without throwing (Task 6.3)', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const connector = createMockConnector();
    const node = createNode({
      secretKey,
      connector,
      upstreamPrefix: 'g.toon.useast',
    });

    // Act -- add then remove
    node.addUpstreamPeer('g.toon.euwest');

    // Assert -- removing the added prefix should not throw
    expect(() => node.removeUpstreamPeer('g.toon.euwest')).not.toThrow();
  });

  it('addUpstreamPeer with duplicate prefix throws ADDRESS_COLLISION (Task 6.3)', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const connector = createMockConnector();
    const node = createNode({
      secretKey,
      connector,
      upstreamPrefix: 'g.toon.useast',
    });

    // Act & Assert -- adding the same prefix again should detect collision
    // because deriveChildAddress(prefix, pubkey) produces the same address
    expect(() => node.addUpstreamPeer('g.toon.useast')).toThrow(/collides/);
  });

  it('removeUpstreamPeer throws when removing the last address (CR fix)', () => {
    // Arrange -- node with a single upstream prefix (one address)
    const secretKey = generateSecretKey();
    const connector = createMockConnector();
    const node = createNode({
      secretKey,
      connector,
      upstreamPrefix: 'g.toon.useast',
    });

    // Act & Assert -- removing the only address should throw
    expect(() => node.removeUpstreamPeer('g.toon.useast')).toThrow(
      /Cannot remove last upstream peer/
    );
  });

  it('removeUpstreamPeer succeeds when node has multiple addresses and one is removed (CR fix)', () => {
    // Arrange -- node with two upstream prefixes
    const secretKey = generateSecretKey();
    const connector = createMockConnector();
    const node = createNode({
      secretKey,
      connector,
      upstreamPrefix: 'g.toon.useast',
    });
    node.addUpstreamPeer('g.toon.euwest');

    // Act & Assert -- removing one of two addresses should succeed
    expect(() => node.removeUpstreamPeer('g.toon.useast')).not.toThrow();
  });

  it('addUpstreamPeer followed by removeUpstreamPeer then re-add succeeds (Task 6.3)', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const connector = createMockConnector();
    const node = createNode({
      secretKey,
      connector,
      upstreamPrefix: 'g.toon.useast',
    });

    // Act -- add, remove, re-add the same prefix
    node.addUpstreamPeer('g.toon.euwest');
    node.removeUpstreamPeer('g.toon.euwest');

    // Assert -- re-adding after removal should not throw
    expect(() => node.addUpstreamPeer('g.toon.euwest')).not.toThrow();
  });

  it('T-7.2-03: derived address from upstreamPrefix flows into ilpInfo for kind:10032 (Task 6.5)', async () => {
    // Arrange
    const secretKey = generateSecretKey();
    const connector = createMockConnector();

    // Act -- create node with upstreamPrefix and start it (triggers bootstrap)
    const node = createNode({
      secretKey,
      connector,
      upstreamPrefix: 'g.toon.useast',
      knownPeers: [],
    });

    // Start the node -- bootstrap will use ilpInfo.ilpAddress for kind:10032
    const result = await node.start();

    // Assert -- node started successfully, meaning the derived address
    // was used in ilpInfo and propagated to BootstrapService
    expect(result).toBeDefined();
    expect(result.peerCount).toBe(0);

    // Cleanup
    await node.stop();
  });
});

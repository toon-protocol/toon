import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// These imports will FAIL until the implementation is created (TDD RED PHASE)
// resolveRouteFees: packages/core/src/fee/resolve-route-fees.ts
// ---------------------------------------------------------------------------
import { resolveRouteFees } from './resolve-route-fees.js';
import { calculateRouteAmount } from './calculate-route-amount.js';
import type { DiscoveredPeer } from '../bootstrap/types.js';
import type { IlpPeerInfo } from '../types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Creates a minimal DiscoveredPeer with the given ILP address and feePerByte. */
function createDiscoveredPeer(
  ilpAddress: string,
  feePerByte: string,
  overrides: { ilpAddresses?: string[]; pubkey?: string } = {}
): DiscoveredPeer {
  const pubkey =
    overrides.pubkey ?? ilpAddress.replace(/\./g, '').padEnd(64, '0');
  const peerInfo: IlpPeerInfo = {
    ilpAddress,
    btpEndpoint: `wss://${ilpAddress}.example.com:8080`,
    assetCode: 'USD',
    assetScale: 6,
    feePerByte,
    ...(overrides.ilpAddresses && { ilpAddresses: overrides.ilpAddresses }),
  };
  return {
    pubkey,
    peerId: `nostr-${pubkey.slice(0, 16)}`,
    peerInfo,
    discoveredAt: Math.floor(Date.now() / 1000),
  };
}

// ---------------------------------------------------------------------------
// T-7.5-06 [P0] Direct route (sender and destination share same parent)
// ---------------------------------------------------------------------------
describe('resolveRouteFees -- direct route (no intermediaries)', () => {
  it('T-7.5-06a: sender and destination under same parent -> empty hopFees', () => {
    // Arrange: both under g.toon.useast
    const ownIlpAddress = 'g.toon.useast.client1';
    const destination = 'g.toon.useast.relay42';
    const discoveredPeers: DiscoveredPeer[] = [];

    // Act
    const result = resolveRouteFees({
      destination,
      ownIlpAddress,
      discoveredPeers,
    });

    // Assert
    expect(result.hopFees).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('destination is own address (self-publish) -> empty hopFees', () => {
    // Arrange
    const ownIlpAddress = 'g.toon.useast.client1';
    const destination = 'g.toon.useast.client1';
    const discoveredPeers: DiscoveredPeer[] = [];

    // Act
    const result = resolveRouteFees({
      destination,
      ownIlpAddress,
      discoveredPeers,
    });

    // Assert
    expect(result.hopFees).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// T-7.5-06 [P0] Route with known intermediary
// ---------------------------------------------------------------------------
describe('resolveRouteFees -- route with known intermediary', () => {
  it('T-7.5-06b: 2-hop route with known intermediary includes feePerByte', () => {
    // Arrange: sender g.toon.useast.client1, destination g.toon.euwest.relay42
    // LCA = g.toon, intermediary = g.toon.euwest
    const ownIlpAddress = 'g.toon.useast.client1';
    const destination = 'g.toon.euwest.relay42';
    const discoveredPeers = [createDiscoveredPeer('g.toon.euwest', '5')];

    // Act
    const result = resolveRouteFees({
      destination,
      ownIlpAddress,
      discoveredPeers,
    });

    // Assert: one intermediary (g.toon.euwest) with fee 5
    expect(result.hopFees).toEqual([5n]);
    expect(result.warnings).toEqual([]);
  });

  it('route with multiple known intermediaries extracts fees in correct order', () => {
    // Arrange: sender g.toon.useast.client1, destination g.toon.euwest.region1.relay42
    // LCA = g.toon, intermediaries: g.toon.euwest (fee 2), g.toon.euwest.region1 (fee 7)
    const ownIlpAddress = 'g.toon.useast.client1';
    const destination = 'g.toon.euwest.region1.relay42';
    const discoveredPeers = [
      createDiscoveredPeer('g.toon.euwest', '2'),
      createDiscoveredPeer('g.toon.euwest.region1', '7'),
    ];

    // Act
    const result = resolveRouteFees({
      destination,
      ownIlpAddress,
      discoveredPeers,
    });

    // Assert: two intermediaries in order: g.toon.euwest (2), g.toon.euwest.region1 (7)
    expect(result.hopFees).toEqual([2n, 7n]);
    expect(result.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// T-7.5-07 [P1] Unknown intermediary defaults to 0n with warning
// ---------------------------------------------------------------------------
describe('resolveRouteFees -- unknown intermediary', () => {
  it('T-7.5-07: unknown intermediary defaults to feePerByte 0n and produces warning', () => {
    // Arrange: sender g.toon.useast.client1, destination g.toon.euwest.relay42
    // g.toon.euwest is NOT in discoveredPeers
    const ownIlpAddress = 'g.toon.useast.client1';
    const destination = 'g.toon.euwest.relay42';
    const discoveredPeers: DiscoveredPeer[] = [];

    // Act
    const result = resolveRouteFees({
      destination,
      ownIlpAddress,
      discoveredPeers,
    });

    // Assert: one intermediary with default 0n fee
    expect(result.hopFees).toEqual([0n]);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain('g.toon.euwest');
    expect(result.warnings[0]).toContain('defaulting feePerByte to 0');
  });
});

// ---------------------------------------------------------------------------
// Intermediary with undefined feePerByte (optional field defaults to 0)
// ---------------------------------------------------------------------------
describe('resolveRouteFees -- undefined feePerByte', () => {
  it('intermediary with undefined feePerByte defaults to 0n (no warning)', () => {
    // Arrange: peer exists but feePerByte is undefined (pre-Story-7.4 peer info)
    const ownIlpAddress = 'g.toon.useast.client1';
    const destination = 'g.toon.euwest.relay42';
    const peer = createDiscoveredPeer('g.toon.euwest', '0');
    // Manually set feePerByte to undefined to simulate a pre-7.4 peer
    (peer.peerInfo as { feePerByte?: string }).feePerByte = undefined;
    const discoveredPeers = [peer];

    // Act
    const result = resolveRouteFees({
      destination,
      ownIlpAddress,
      discoveredPeers,
    });

    // Assert: peer is found (no warning), feePerByte ?? '0' -> 0n
    expect(result.hopFees).toEqual([0n]);
    expect(result.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Multi-address matching (Story 7.3 ilpAddresses array)
// ---------------------------------------------------------------------------
describe('resolveRouteFees -- multi-address peer matching', () => {
  it('intermediary with ilpAddresses array matched by any address', () => {
    // Arrange: peer has primary address g.toon.node1 but also g.toon.euwest in ilpAddresses
    const ownIlpAddress = 'g.toon.useast.client1';
    const destination = 'g.toon.euwest.relay42';
    const discoveredPeers = [
      createDiscoveredPeer('g.toon.node1', '3', {
        ilpAddresses: ['g.toon.node1', 'g.toon.euwest'],
      }),
    ];

    // Act
    const result = resolveRouteFees({
      destination,
      ownIlpAddress,
      discoveredPeers,
    });

    // Assert: matched via ilpAddresses array
    expect(result.hopFees).toEqual([3n]);
    expect(result.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Composition: resolveRouteFees + calculateRouteAmount (AC#2 + AC#5)
// ---------------------------------------------------------------------------
describe('resolveRouteFees + calculateRouteAmount composition', () => {
  it('AC#2+AC#5: multi-hop route with discovered peers produces correct total amount', () => {
    // Arrange: sender g.toon.useast.client1, destination g.toon.apac.region2.relay99
    // LCA = g.toon, intermediaries: g.toon.apac (fee 2), g.toon.apac.region2 (fee 3)
    const ownIlpAddress = 'g.toon.useast.client1';
    const destination = 'g.toon.apac.region2.relay99';
    const discoveredPeers = [
      createDiscoveredPeer('g.toon.apac', '2'),
      createDiscoveredPeer('g.toon.apac.region2', '3'),
    ];

    // Act -- resolve fees
    const { hopFees, warnings } = resolveRouteFees({
      destination,
      ownIlpAddress,
      discoveredPeers,
    });

    // Then compute amount using the resolved fees
    const basePricePerByte = 10n;
    const packetByteLength = 100;
    const amount = calculateRouteAmount({
      basePricePerByte,
      packetByteLength,
      hopFees,
    });

    // Assert: (10 * 100) + (2 * 100) + (3 * 100) = 1000 + 200 + 300 = 1500
    expect(amount).toBe(1500n);
    expect(warnings).toEqual([]);
  });

  it('AC#2+AC#5+AC#6: composition with mix of known and unknown intermediaries', () => {
    // Arrange: sender g.toon.us.client1, destination g.toon.eu.region1.relay42
    // LCA = g.toon, intermediaries: g.toon.eu (known, fee 5), g.toon.eu.region1 (unknown)
    const ownIlpAddress = 'g.toon.us.client1';
    const destination = 'g.toon.eu.region1.relay42';
    const discoveredPeers = [createDiscoveredPeer('g.toon.eu', '5')];

    // Act -- resolve fees
    const { hopFees, warnings } = resolveRouteFees({
      destination,
      ownIlpAddress,
      discoveredPeers,
    });

    // Then compute amount
    const amount = calculateRouteAmount({
      basePricePerByte: 10n,
      packetByteLength: 100,
      hopFees,
    });

    // Assert: (10 * 100) + (5 * 100) + (0 * 100) = 1000 + 500 + 0 = 1500
    expect(amount).toBe(1500n);
    expect(hopFees).toEqual([5n, 0n]);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('g.toon.eu.region1');
  });
});

// ---------------------------------------------------------------------------
// Defensive guards: negative feePerByte, empty addresses
// ---------------------------------------------------------------------------
describe('resolveRouteFees -- defensive guards', () => {
  it('negative feePerByte from malicious peer is clamped to 0n', () => {
    const ownIlpAddress = 'g.toon.useast.client1';
    const destination = 'g.toon.euwest.relay42';
    const discoveredPeers = [createDiscoveredPeer('g.toon.euwest', '-5')];

    const result = resolveRouteFees({
      destination,
      ownIlpAddress,
      discoveredPeers,
    });

    // Negative fee clamped to 0n
    expect(result.hopFees).toEqual([0n]);
    expect(result.warnings).toEqual([]);
  });

  it('malformed feePerByte (non-numeric string) defaults to 0n with warning', () => {
    const ownIlpAddress = 'g.toon.useast.client1';
    const destination = 'g.toon.euwest.relay42';
    const discoveredPeers = [createDiscoveredPeer('g.toon.euwest', 'abc')];

    const result = resolveRouteFees({
      destination,
      ownIlpAddress,
      discoveredPeers,
    });

    // Malformed fee defaults to 0n with a warning
    expect(result.hopFees).toEqual([0n]);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain('Invalid feePerByte');
    expect(result.warnings[0]).toContain('abc');
    expect(result.warnings[0]).toContain('g.toon.euwest');
  });

  it('feePerByte with decimal (e.g. "1.5") defaults to 0n with warning', () => {
    const ownIlpAddress = 'g.toon.useast.client1';
    const destination = 'g.toon.euwest.relay42';
    const discoveredPeers = [createDiscoveredPeer('g.toon.euwest', '1.5')];

    const result = resolveRouteFees({
      destination,
      ownIlpAddress,
      discoveredPeers,
    });

    expect(result.hopFees).toEqual([0n]);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain('Invalid feePerByte');
  });

  it('empty destination returns empty hopFees', () => {
    const result = resolveRouteFees({
      destination: '',
      ownIlpAddress: 'g.toon.useast.client1',
      discoveredPeers: [],
    });

    expect(result.hopFees).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('empty ownIlpAddress returns empty hopFees', () => {
    const result = resolveRouteFees({
      destination: 'g.toon.euwest.relay42',
      ownIlpAddress: '',
      discoveredPeers: [],
    });

    expect(result.hopFees).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// T-7.5-10 [P1] Route table update -- fee reflects latest discovered data
// ---------------------------------------------------------------------------
describe('resolveRouteFees -- route table update', () => {
  it('T-7.5-10: updated feePerByte in discoveredPeers is reflected in subsequent calls', () => {
    // Arrange: initial fee is 5
    const ownIlpAddress = 'g.toon.useast.client1';
    const destination = 'g.toon.euwest.relay42';
    const discoveredPeers = [createDiscoveredPeer('g.toon.euwest', '5')];

    // Act -- first call
    const result1 = resolveRouteFees({
      destination,
      ownIlpAddress,
      discoveredPeers,
    });

    // Assert -- initial fee
    expect(result1.hopFees).toEqual([5n]);

    // Arrange -- update fee to 15 (simulating a new kind:10032 event processed)
    discoveredPeers[0] = createDiscoveredPeer('g.toon.euwest', '15');

    // Act -- second call with updated peers
    const result2 = resolveRouteFees({
      destination,
      ownIlpAddress,
      discoveredPeers,
    });

    // Assert -- updated fee
    expect(result2.hopFees).toEqual([15n]);
    expect(result2.warnings).toEqual([]);
  });
});

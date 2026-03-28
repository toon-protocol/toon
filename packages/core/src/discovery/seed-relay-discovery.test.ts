/**
 * ATDD tests for Story 3.4: Seed Relay Discovery (FR-PROD-4)
 *
 * Validates:
 * - Seed relay list discovery via kind:10036 events
 * - Fallback when seed relays are unreachable
 * - Backward compatibility with genesis discovery mode
 * - Publishing kind:10036 seed list events
 * - Event building/parsing for kind:10036
 * - URL and pubkey validation
 * - Static analysis: no SimplePool usage
 *
 * Test IDs from test-design-epic-3.md:
 * - T-3.4-01 [P1]: Seed relay discovery happy path (3.4-INT-001)
 * - T-3.4-02 [P1]: Seed relay fallback on failure (3.4-INT-002)
 * - T-3.4-03 [P1]: All seeds exhausted -> clear error (3.4-INT-002)
 * - T-3.4-04 [P1]: Genesis mode backward compatibility (3.4-INT-003)
 * - T-3.4-05 [P1]: Publish kind:10036 seed list event (3.4-INT-004)
 * - T-3.4-06 [P2]: Static analysis: no SimplePool in seed-relay-discovery.ts
 * - T-3.4-07 [P2]: buildSeedRelayListEvent() returns NIP-16 replaceable event
 * - T-3.4-08 [P2]: parseSeedRelayList() validates URLs
 * - T-3.4-09 [P2]: parseSeedRelayList() validates pubkeys
 * - T-3.4-10 [P2]: parseSeedRelayList() ignores malformed entries
 * - T-3.4-11 [P2]: SEED_RELAY_LIST_KIND equals 10036
 * - T-3.4-12 [P3]: E2E stub (deferred, requires genesis infrastructure)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';

// Mock verifyEvent to return true by default in tests (mock events have
// synthetic signatures). The mock is reset to return true in beforeEach.
vi.mock('nostr-tools/pure', async (importOriginal) => {
  const mod = (await importOriginal()) as Record<string, unknown>;
  return {
    ...mod,
    verifyEvent: vi.fn().mockReturnValue(true),
  };
});

import {
  SeedRelayDiscovery,
  publishSeedRelayEntry,
  type SeedRelayDiscoveryConfig,
  type SeedRelayEntry,
} from './seed-relay-discovery.js';

import {
  buildSeedRelayListEvent,
  parseSeedRelayList,
} from '../events/seed-relay.js';

import { SEED_RELAY_LIST_KIND, ILP_PEER_INFO_KIND } from '../constants.js';
import { PeerDiscoveryError } from '../errors.js';

// ============================================================================
// Mock WebSocket
// ============================================================================

/**
 * Mock WebSocket that simulates a Nostr relay.
 * Supports programmable responses to REQ and EVENT messages.
 */
class MockWebSocket extends EventEmitter {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 1; // OPEN

  // Programmable responses: kind -> events to return on REQ
  private _kindResponses = new Map<number, NostrEvent[]>();
  // Programmable OK responses for EVENT publishes
  private _okResponse = true;
  private _shouldFail = false;
  private _url: string;

  constructor(url: string) {
    super();
    this._url = url;

    if (this._shouldFail) {
      // Defer error emission
      setTimeout(() => {
        this.emit('error', new Error('Connection refused'));
      }, 0);
      return;
    }

    // Defer open event to next tick (simulates async connection)
    setTimeout(() => {
      this.emit('open');
    }, 0);
  }

  send(data: string) {
    const msg = JSON.parse(data) as unknown[];

    if (msg[0] === 'REQ') {
      const subId = msg[1] as string;
      const filter = msg[2] as Record<string, unknown>;
      const kinds = (filter['kinds'] as number[]) ?? [];

      // Send matching events
      for (const kind of kinds) {
        const events = this._kindResponses.get(kind) ?? [];
        for (const event of events) {
          setTimeout(() => {
            this.emit('message', JSON.stringify(['EVENT', subId, event]));
          }, 0);
        }
      }

      // Send EOSE after events
      setTimeout(() => {
        this.emit('message', JSON.stringify(['EOSE', subId]));
      }, 10);
    }

    if (msg[0] === 'EVENT') {
      const event = msg[1] as NostrEvent;
      setTimeout(() => {
        this.emit(
          'message',
          JSON.stringify(['OK', event.id, this._okResponse, ''])
        );
      }, 0);
    }

    if (msg[0] === 'CLOSE') {
      // No-op for close messages
    }
  }

  close() {
    this.readyState = 3; // CLOSED
    this.removeAllListeners();
  }

  // Test helper: set events to return for a given kind
  _setKindResponses(kind: number, events: NostrEvent[]) {
    this._kindResponses.set(kind, events);
  }

  _setOkResponse(ok: boolean) {
    this._okResponse = ok;
  }
}

/**
 * Mock WebSocket that fails to connect.
 */
class FailingMockWebSocket extends EventEmitter {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 0; // CONNECTING

  constructor(_url: string) {
    super();
    setTimeout(() => {
      this.emit('error', new Error('Connection refused'));
    }, 0);
  }

  send() {
    throw new Error('Not connected');
  }

  close() {
    this.readyState = 3;
    this.removeAllListeners();
  }
}

// Track created mock instances for test manipulation
let mockWebSocketInstances: MockWebSocket[] = [];
let webSocketConstructorBehavior: 'success' | 'fail' | 'custom' = 'success';
let customWebSocketFactory:
  | ((url: string) => MockWebSocket | FailingMockWebSocket)
  | undefined;

// Mock the ws module
vi.mock('ws', () => {
  const MockWS = function (
    this: MockWebSocket | FailingMockWebSocket,
    url: string
  ) {
    if (webSocketConstructorBehavior === 'fail') {
      const instance = new FailingMockWebSocket(url);
      return instance;
    }
    if (webSocketConstructorBehavior === 'custom' && customWebSocketFactory) {
      const instance = customWebSocketFactory(url);
      if (instance instanceof MockWebSocket) {
        mockWebSocketInstances.push(instance);
      }
      return instance;
    }
    const instance = new MockWebSocket(url);
    mockWebSocketInstances.push(instance);
    return instance;
  };
  MockWS.OPEN = 1;
  MockWS.CONNECTING = 0;
  return { default: MockWS };
});

// ============================================================================
// Factories
// ============================================================================

/**
 * Creates an array of mock seed relay entries.
 */
function createSeedRelayList(count = 3): SeedRelayEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    url: `wss://seed-relay-${i + 1}.toon.example.com`,
    pubkey: `${String(i + 1).padStart(2, '0')}`.repeat(32),
    metadata: { region: 'us-east', version: '1.0.0' },
  }));
}

/**
 * Creates a mock kind:10036 Nostr event.
 */
function createSeedRelayEvent(
  seedRelays: SeedRelayEntry[] = createSeedRelayList(),
  overrides: Partial<NostrEvent> = {}
): NostrEvent {
  return {
    id: 'a'.repeat(64),
    pubkey: 'b'.repeat(64),
    kind: 10036,
    content: JSON.stringify(seedRelays),
    tags: [['d', 'toon-seed-list']],
    created_at: Math.floor(Date.now() / 1000),
    sig: 'c'.repeat(128),
    ...overrides,
  } as NostrEvent;
}

/**
 * Creates a mock kind:10032 ILP Peer Info event.
 */
function createIlpPeerInfoEvent(
  pubkey: string,
  overrides: Record<string, unknown> = {}
): NostrEvent {
  return {
    id: `peer-event-${pubkey.slice(0, 8)}`,
    pubkey,
    kind: ILP_PEER_INFO_KIND,
    content: JSON.stringify({
      ilpAddress: overrides['ilpAddress'] ?? 'g.test.peer',
      btpEndpoint: overrides['btpEndpoint'] ?? 'wss://btp.test',
      assetCode: overrides['assetCode'] ?? 'USDC',
      assetScale: overrides['assetScale'] ?? 6,
    }),
    tags: [],
    created_at: Math.floor(Date.now() / 1000),
    sig: 'd'.repeat(128),
  } as NostrEvent;
}

/**
 * Creates a mock SeedRelayDiscoveryConfig.
 */
function createDiscoveryConfig(
  overrides: Partial<SeedRelayDiscoveryConfig> = {}
): SeedRelayDiscoveryConfig {
  return {
    publicRelays: overrides.publicRelays ?? ['wss://relay.damus.io'],
    connectionTimeout: overrides.connectionTimeout ?? 5000,
    queryTimeout: overrides.queryTimeout ?? 3000,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('Story 3.4: Seed Relay Discovery', () => {
  beforeEach(() => {
    mockWebSocketInstances = [];
    webSocketConstructorBehavior = 'success';
    customWebSocketFactory = undefined;
    // Reset verifyEvent mock to return true (default for tests with synthetic events)
    (verifyEvent as ReturnType<typeof vi.fn>).mockReturnValue(true);
  });

  afterEach(() => {
    for (const ws of mockWebSocketInstances) {
      ws.close();
    }
    mockWebSocketInstances = [];
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // T-3.4-11 [P2]: SEED_RELAY_LIST_KIND constant
  // --------------------------------------------------------------------------
  describe('Constants (T-3.4-11)', () => {
    it('[P2] SEED_RELAY_LIST_KIND equals 10036', () => {
      // Assert
      // The constant must be exported from @toon-protocol/core constants
      expect(SEED_RELAY_LIST_KIND).toBe(10036);
    });
  });

  // --------------------------------------------------------------------------
  // T-3.4-07 [P2]: buildSeedRelayListEvent()
  // --------------------------------------------------------------------------
  describe('buildSeedRelayListEvent (T-3.4-07)', () => {
    it('[P2] returns NIP-16 replaceable event with correct kind and d-tag', () => {
      // Arrange
      const secretKey = generateSecretKey();
      const entries = createSeedRelayList(2);

      // Act
      const event = buildSeedRelayListEvent(secretKey, entries);

      // Assert -- kind must be 10036 (NIP-16 replaceable: 10000-19999)
      expect(event.kind).toBe(10036);
      // Assert -- must have d-tag with value 'toon-seed-list'
      const dTag = event.tags.find((t: string[]) => t[0] === 'd');
      expect(dTag).toBeDefined();
      expect(dTag![1]).toBe('toon-seed-list');
      // Assert -- content is JSON-serialized SeedRelayEntry[]
      const content = JSON.parse(event.content) as SeedRelayEntry[];
      expect(content).toHaveLength(2);
      expect(content[0]!.url).toBe(entries[0]!.url);
      expect(content[1]!.pubkey).toBe(entries[1]!.pubkey);
      // Assert -- event is signed (has valid id and sig)
      expect(event.id).toMatch(/^[0-9a-f]{64}$/);
      expect(event.sig).toMatch(/^[0-9a-f]{128}$/);
      // Assert -- pubkey matches derived key
      expect(event.pubkey).toBe(getPublicKey(secretKey));
    });

    it('[P2] includes metadata in serialized entries', () => {
      // Arrange
      const secretKey = generateSecretKey();
      const entries: SeedRelayEntry[] = [
        {
          url: 'wss://relay.example.com',
          pubkey: 'ff'.repeat(32),
          metadata: {
            region: 'eu-west',
            version: '2.0.0',
            services: ['relay', 'x402'],
          },
        },
      ];

      // Act
      const event = buildSeedRelayListEvent(secretKey, entries);
      const content = JSON.parse(event.content) as SeedRelayEntry[];

      // Assert
      expect(content[0]!.metadata).toEqual({
        region: 'eu-west',
        version: '2.0.0',
        services: ['relay', 'x402'],
      });
    });
  });

  // --------------------------------------------------------------------------
  // T-3.4-08 [P2]: parseSeedRelayList() validates URLs
  // --------------------------------------------------------------------------
  describe('parseSeedRelayList - URL validation (T-3.4-08)', () => {
    it('[P2] accepts entries with ws:// prefix', () => {
      // Arrange
      const entries: SeedRelayEntry[] = [
        { url: 'ws://localhost:7100', pubkey: 'aa'.repeat(32) },
      ];
      const event = createSeedRelayEvent(entries);

      // Act
      const result = parseSeedRelayList(event);

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0]!.url).toBe('ws://localhost:7100');
    });

    it('[P2] accepts entries with wss:// prefix', () => {
      // Arrange
      const entries: SeedRelayEntry[] = [
        { url: 'wss://relay.toon.example.com', pubkey: 'bb'.repeat(32) },
      ];
      const event = createSeedRelayEvent(entries);

      // Act
      const result = parseSeedRelayList(event);

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0]!.url).toBe('wss://relay.toon.example.com');
    });

    it('[P2] rejects entries with http:// prefix (non-WebSocket)', () => {
      // Arrange
      const entries = [
        { url: 'http://relay.example.com', pubkey: 'cc'.repeat(32) },
        { url: 'wss://valid-relay.example.com', pubkey: 'dd'.repeat(32) },
      ];
      const event = createSeedRelayEvent(entries as SeedRelayEntry[]);

      // Act
      const result = parseSeedRelayList(event);

      // Assert -- only the valid wss:// entry should remain
      expect(result).toHaveLength(1);
      expect(result[0]!.url).toBe('wss://valid-relay.example.com');
    });

    it('[P2] rejects entries with no protocol prefix', () => {
      // Arrange
      const entries = [{ url: 'relay.example.com', pubkey: 'ee'.repeat(32) }];
      const event = createSeedRelayEvent(entries as SeedRelayEntry[]);

      // Act
      const result = parseSeedRelayList(event);

      // Assert
      expect(result).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // T-3.4-09 [P2]: parseSeedRelayList() validates pubkeys
  // --------------------------------------------------------------------------
  describe('parseSeedRelayList - pubkey validation (T-3.4-09)', () => {
    it('[P2] accepts valid 64-char lowercase hex pubkeys', () => {
      // Arrange
      const entries: SeedRelayEntry[] = [
        { url: 'wss://relay.example.com', pubkey: 'ab'.repeat(32) },
      ];
      const event = createSeedRelayEvent(entries);

      // Act
      const result = parseSeedRelayList(event);

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0]!.pubkey).toBe('ab'.repeat(32));
    });

    it('[P2] rejects entries with uppercase hex pubkeys', () => {
      // Arrange
      const entries = [
        { url: 'wss://relay.example.com', pubkey: 'AB'.repeat(32) },
      ];
      const event = createSeedRelayEvent(entries as SeedRelayEntry[]);

      // Act
      const result = parseSeedRelayList(event);

      // Assert
      expect(result).toHaveLength(0);
    });

    it('[P2] rejects entries with wrong-length pubkeys', () => {
      // Arrange
      const entries = [
        { url: 'wss://relay.example.com', pubkey: 'aa'.repeat(16) }, // 32 chars, not 64
      ];
      const event = createSeedRelayEvent(entries as SeedRelayEntry[]);

      // Act
      const result = parseSeedRelayList(event);

      // Assert
      expect(result).toHaveLength(0);
    });

    it('[P2] rejects entries with non-hex pubkeys', () => {
      // Arrange
      const entries = [
        { url: 'wss://relay.example.com', pubkey: 'zz'.repeat(32) },
      ];
      const event = createSeedRelayEvent(entries as SeedRelayEntry[]);

      // Act
      const result = parseSeedRelayList(event);

      // Assert
      expect(result).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // T-3.4-10 [P2]: parseSeedRelayList() ignores malformed entries
  // --------------------------------------------------------------------------
  describe('parseSeedRelayList - malformed entries (T-3.4-10)', () => {
    it('[P2] ignores entries missing url field', () => {
      // Arrange
      const event = {
        ...createSeedRelayEvent(),
        content: JSON.stringify([
          { pubkey: 'aa'.repeat(32) }, // missing url
          { url: 'wss://valid.example.com', pubkey: 'bb'.repeat(32) },
        ]),
      } as NostrEvent;

      // Act
      const result = parseSeedRelayList(event);

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0]!.url).toBe('wss://valid.example.com');
    });

    it('[P2] ignores entries missing pubkey field', () => {
      // Arrange
      const event = {
        ...createSeedRelayEvent(),
        content: JSON.stringify([
          { url: 'wss://no-pubkey.example.com' }, // missing pubkey
          { url: 'wss://valid.example.com', pubkey: 'cc'.repeat(32) },
        ]),
      } as NostrEvent;

      // Act
      const result = parseSeedRelayList(event);

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0]!.url).toBe('wss://valid.example.com');
    });

    it('[P2] ignores non-object entries in array', () => {
      // Arrange
      const event = {
        ...createSeedRelayEvent(),
        content: JSON.stringify([
          'not-an-object',
          42,
          null,
          { url: 'wss://valid.example.com', pubkey: 'dd'.repeat(32) },
        ]),
      } as NostrEvent;

      // Act
      const result = parseSeedRelayList(event);

      // Assert
      expect(result).toHaveLength(1);
    });

    it('[P2] returns empty array for invalid JSON content', () => {
      // Arrange
      const event = {
        ...createSeedRelayEvent(),
        content: 'not valid json',
      } as NostrEvent;

      // Act
      const result = parseSeedRelayList(event);

      // Assert
      expect(result).toHaveLength(0);
    });

    it('[P2] returns empty array for non-array JSON content', () => {
      // Arrange
      const event = {
        ...createSeedRelayEvent(),
        content: JSON.stringify({ url: 'wss://single.example.com' }),
      } as NostrEvent;

      // Act
      const result = parseSeedRelayList(event);

      // Assert
      expect(result).toHaveLength(0);
    });

    it('[P2] preserves valid metadata when present', () => {
      // Arrange
      const entries: SeedRelayEntry[] = [
        {
          url: 'wss://relay.example.com',
          pubkey: 'ee'.repeat(32),
          metadata: { region: 'ap-south', version: '1.5.0' },
        },
      ];
      const event = createSeedRelayEvent(entries);

      // Act
      const result = parseSeedRelayList(event);

      // Assert
      expect(result[0]!.metadata).toEqual({
        region: 'ap-south',
        version: '1.5.0',
      });
    });
  });

  // --------------------------------------------------------------------------
  // T-3.4-01 [P1]: Seed relay discovery happy path (3.4-INT-001)
  // Risk: E3-R006
  // --------------------------------------------------------------------------
  describe('Seed relay discovery happy path (3.4-INT-001)', () => {
    it('[P1] reads kind:10036 -> connects to seed -> subscribes kind:10032', async () => {
      // Arrange
      const seedEntries = createSeedRelayList(2);
      const seedRelayEvent = createSeedRelayEvent(seedEntries);
      const peerPubkey = 'ab'.repeat(32);
      const peerInfoEvent = createIlpPeerInfoEvent(peerPubkey);

      // Track connection URLs to differentiate public relay vs seed relay
      let callCount = 0;
      customWebSocketFactory = (_url: string) => {
        const ws = new MockWebSocket(_url);
        callCount++;
        if (callCount === 1) {
          // First connection = public relay -> return kind:10036
          ws._setKindResponses(SEED_RELAY_LIST_KIND, [seedRelayEvent]);
        } else {
          // Subsequent connections = seed relay -> return kind:10032
          ws._setKindResponses(ILP_PEER_INFO_KIND, [peerInfoEvent]);
        }
        return ws;
      };
      webSocketConstructorBehavior = 'custom';

      const config = createDiscoveryConfig({
        publicRelays: ['wss://relay.damus.io'],
      });
      const discovery = new SeedRelayDiscovery(config);

      // Act
      const result = await discovery.discover();

      // Assert -- discovery was successful
      expect(result).toBeDefined();
      expect(result.seedRelaysConnected).toBe(1);
      expect(result.attemptedSeeds).toBeGreaterThanOrEqual(1);
      expect(result.connectedUrls).toHaveLength(1);
      // Assert -- result shape matches SeedRelayDiscoveryResult
      expect(typeof result.seedRelaysConnected).toBe('number');
      expect(Array.isArray(result.connectedUrls)).toBe(true);
      expect(Array.isArray(result.discoveredPeers)).toBe(true);
      // Assert -- discovered peers from kind:10032
      expect(result.discoveredPeers).toHaveLength(1);
      expect(result.discoveredPeers[0]!.pubkey).toBe(peerPubkey);
      expect(result.discoveredPeers[0]!.ilpAddress).toBe('g.test.peer');
      expect(result.discoveredPeers[0]!.btpEndpoint).toBe('wss://btp.test');

      // Cleanup
      await discovery.close();
    });
  });

  // --------------------------------------------------------------------------
  // T-3.4-02 [P1]: Seed relay fallback on failure (3.4-INT-002)
  // Risk: E3-R006
  // --------------------------------------------------------------------------
  describe('Seed relay fallback (3.4-INT-002)', () => {
    it('[P1] first seed unreachable -> tries next in list', async () => {
      // Arrange
      const seedEntries: SeedRelayEntry[] = [
        { url: 'wss://unreachable-seed.example.com', pubkey: 'aa'.repeat(32) },
        { url: 'wss://good-seed.example.com', pubkey: 'bb'.repeat(32) },
      ];
      const seedRelayEvent = createSeedRelayEvent(seedEntries);
      const peerInfoEvent = createIlpPeerInfoEvent('cc'.repeat(32));

      let callCount = 0;
      customWebSocketFactory = (url: string) => {
        callCount++;
        if (callCount === 1) {
          // Public relay -> return kind:10036 listing two seeds
          const ws = new MockWebSocket(url);
          ws._setKindResponses(SEED_RELAY_LIST_KIND, [seedRelayEvent]);
          return ws;
        }
        if (url === 'wss://unreachable-seed.example.com') {
          // First seed fails
          return new FailingMockWebSocket(url) as unknown as MockWebSocket;
        }
        // Second seed succeeds
        const ws = new MockWebSocket(url);
        ws._setKindResponses(ILP_PEER_INFO_KIND, [peerInfoEvent]);
        return ws;
      };
      webSocketConstructorBehavior = 'custom';

      const config = createDiscoveryConfig({
        publicRelays: ['wss://relay.damus.io'],
        connectionTimeout: 1000,
      });
      const discovery = new SeedRelayDiscovery(config);

      // Act
      const result = await discovery.discover();

      // Assert -- attempted more than one seed relay
      expect(result.attemptedSeeds).toBe(2);
      // Assert -- connected to the second seed
      expect(result.seedRelaysConnected).toBe(1);
      expect(result.connectedUrls).toContain('wss://good-seed.example.com');

      // Cleanup
      await discovery.close();
    });
  });

  // --------------------------------------------------------------------------
  // T-3.4-03 [P1]: All seeds exhausted -> clear error (3.4-INT-002)
  // Risk: E3-R006
  // --------------------------------------------------------------------------
  describe('All seeds exhausted (3.4-INT-002)', () => {
    it('[P1] all seeds exhausted -> clear error message', async () => {
      // Arrange -- public relay returns seed entries, but all seeds fail
      const seedEntries: SeedRelayEntry[] = [
        { url: 'wss://fail-seed-1.example.com', pubkey: 'aa'.repeat(32) },
        { url: 'wss://fail-seed-2.example.com', pubkey: 'bb'.repeat(32) },
      ];
      const seedRelayEvent = createSeedRelayEvent(seedEntries);

      let callCount = 0;
      customWebSocketFactory = (url: string) => {
        callCount++;
        if (callCount === 1) {
          // Public relay returns kind:10036 with two seed entries
          const ws = new MockWebSocket(url);
          ws._setKindResponses(SEED_RELAY_LIST_KIND, [seedRelayEvent]);
          return ws;
        }
        // All seed relay connections fail
        return new FailingMockWebSocket(url) as unknown as MockWebSocket;
      };
      webSocketConstructorBehavior = 'custom';

      const config = createDiscoveryConfig({
        publicRelays: ['wss://relay.damus.io'],
        connectionTimeout: 500,
        queryTimeout: 500,
      });
      const discovery = new SeedRelayDiscovery(config);

      // Act & Assert
      // When all seed relays are unreachable, discover() should throw
      // PeerDiscoveryError with a clear message about exhaustion.
      // NOTE: We call discover() only once and inspect the caught error,
      // rather than calling it twice (which would reset mock state).
      try {
        await discovery.discover();
        expect.fail('Should have thrown PeerDiscoveryError');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(PeerDiscoveryError);
        expect((err as Error).message).toMatch(/all seed relays.*exhausted/i);
      }

      // Cleanup
      await discovery.close();
    });
  });

  // --------------------------------------------------------------------------
  // T-3.4-04 [P1]: Genesis mode backward compatibility (3.4-INT-003)
  // --------------------------------------------------------------------------
  describe('Genesis mode backward compatibility (3.4-INT-003)', () => {
    it('[P1] discovery: "genesis" uses existing bootstrap flow unchanged', () => {
      // The integration point is in startTown() which checks the discovery
      // field. For core-level unit testing, we verify:
      // 1. SeedRelayDiscovery is a separate, opt-in concern (not mandatory)
      // 2. It produces output (KnownPeer-compatible IlpPeerInfo[]) that feeds
      //    into the existing BootstrapService -- it does NOT replace bootstrap
      // 3. The class is constructible without side effects (no auto-connect)
      const config = createDiscoveryConfig();
      const discovery = new SeedRelayDiscovery(config);

      // Assert -- SeedRelayDiscovery exists and is constructible without
      // triggering any connections (important: construction does NOT auto-discover)
      expect(discovery).toBeDefined();
      expect(typeof discovery.discover).toBe('function');
      expect(typeof discovery.close).toBe('function');

      // Assert -- no WebSocket connections were made during construction.
      // In genesis mode, SeedRelayDiscovery is never instantiated, so
      // construction must be side-effect-free.
      expect(mockWebSocketInstances).toHaveLength(0);
    });

    it('[P1] SeedRelayDiscovery result shape is compatible with KnownPeer conversion', async () => {
      // Verify the SeedRelayDiscoveryResult contains all fields needed
      // to convert to KnownPeer[] for BootstrapService.
      // This ensures seed-list discovery feeds into the existing bootstrap
      // flow rather than replacing it.
      const seedEntries = createSeedRelayList(1);
      const seedRelayEvent = createSeedRelayEvent(seedEntries);
      const peerPubkey = 'ab'.repeat(32);
      const peerInfoEvent = createIlpPeerInfoEvent(peerPubkey, {
        ilpAddress: 'g.toon.compat-peer',
        btpEndpoint: 'wss://btp.compat.test',
      });

      let callCount = 0;
      customWebSocketFactory = (_url: string) => {
        callCount++;
        const ws = new MockWebSocket(_url);
        if (callCount === 1) {
          ws._setKindResponses(SEED_RELAY_LIST_KIND, [seedRelayEvent]);
        } else {
          ws._setKindResponses(ILP_PEER_INFO_KIND, [peerInfoEvent]);
        }
        return ws;
      };
      webSocketConstructorBehavior = 'custom';

      const config = createDiscoveryConfig();
      const discovery = new SeedRelayDiscovery(config);
      const result = await discovery.discover();

      // Assert -- result has connectedUrls (needed for KnownPeer.relayUrl)
      expect(result.connectedUrls.length).toBeGreaterThan(0);
      // Assert -- discoveredPeers have pubkey, ilpAddress, btpEndpoint
      // (the three fields required for KnownPeer conversion)
      const peer = result.discoveredPeers[0]!;
      expect(peer.pubkey).toBe(peerPubkey);
      expect(peer.ilpAddress).toBe('g.toon.compat-peer');
      expect(peer.btpEndpoint).toBe('wss://btp.compat.test');

      await discovery.close();
    });
  });

  // --------------------------------------------------------------------------
  // T-3.4-05 [P1]: Publish kind:10036 seed list event (3.4-INT-004)
  // --------------------------------------------------------------------------
  describe('Publish kind:10036 seed list (3.4-INT-004)', () => {
    it('[P1] node publishes its own seed relay entry as kind:10036', async () => {
      // Arrange
      webSocketConstructorBehavior = 'success';
      const secretKey = generateSecretKey();

      // Act
      const result = await publishSeedRelayEntry({
        secretKey,
        relayUrl: 'wss://my-relay.toon.example.com',
        publicRelays: ['wss://relay.damus.io'],
        metadata: { region: 'us-east', version: '1.0.0' },
      });

      // Assert -- result indicates publish was attempted
      expect(result).toBeDefined();
      expect(typeof result.publishedTo).toBe('number');
      expect(typeof result.eventId).toBe('string');
      expect(result.eventId).toMatch(/^[0-9a-f]{64}$/);
      // Assert -- successfully published to the relay
      expect(result.publishedTo).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // T-3.4-06 [P2]: Static analysis: no SimplePool in seed-relay-discovery.ts
  // --------------------------------------------------------------------------
  describe('Static analysis (T-3.4-06)', () => {
    it('[P2] seed relay discovery uses raw ws, not SimplePool', () => {
      // Arrange -- read the source file
      const sourcePath = resolve(__dirname, 'seed-relay-discovery.ts');
      const sourceCode = readFileSync(sourcePath, 'utf-8');

      // Assert -- must NOT import or reference SimplePool
      expect(sourceCode).not.toContain('SimplePool');
      expect(sourceCode).not.toContain('nostr-tools/pool');
      // Assert -- should use raw ws WebSocket
      expect(sourceCode).toContain("from 'ws'");
    });
  });

  // --------------------------------------------------------------------------
  // Security: Event signature verification (CWE-345)
  // --------------------------------------------------------------------------
  describe('Event signature verification (CWE-345)', () => {
    it('skips kind:10036 events with invalid signatures', async () => {
      // Arrange -- mock verifyEvent to reject events
      (verifyEvent as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const seedEntries = createSeedRelayList(1);
      const seedRelayEvent = createSeedRelayEvent(seedEntries);

      customWebSocketFactory = (_url: string) => {
        const ws = new MockWebSocket(_url);
        ws._setKindResponses(SEED_RELAY_LIST_KIND, [seedRelayEvent]);
        return ws;
      };
      webSocketConstructorBehavior = 'custom';

      const config = createDiscoveryConfig({
        publicRelays: ['wss://relay.damus.io'],
      });
      const discovery = new SeedRelayDiscovery(config);

      // Act & Assert -- should throw because no valid seed entries remain
      // (all events fail signature verification)
      try {
        await discovery.discover();
        expect.fail('Should have thrown PeerDiscoveryError');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(PeerDiscoveryError);
        expect((err as Error).message).toContain('0 seed relays');
      }

      await discovery.close();
    });

    it('seed-relay-discovery.ts imports and uses verifyEvent', () => {
      // Static analysis: verify that verifyEvent is imported
      const sourcePath = resolve(__dirname, 'seed-relay-discovery.ts');
      const sourceCode = readFileSync(sourcePath, 'utf-8');
      expect(sourceCode).toContain('verifyEvent');
    });
  });

  // --------------------------------------------------------------------------
  // AC #3 GAP: publishSeedRelayEntry event content verification
  // --------------------------------------------------------------------------
  describe('publishSeedRelayEntry - event content (AC #3)', () => {
    it('published event content contains the node WebSocket URL and pubkey', async () => {
      // Arrange -- capture what the mock WebSocket sends
      const sentMessages: string[] = [];
      customWebSocketFactory = (_url: string) => {
        const ws = new MockWebSocket(_url);
        const originalSend = ws.send.bind(ws);
        ws.send = (data: string) => {
          sentMessages.push(data);
          originalSend(data);
        };
        return ws;
      };
      webSocketConstructorBehavior = 'custom';

      const secretKey = generateSecretKey();
      const expectedPubkey = getPublicKey(secretKey);

      // Act
      const result = await publishSeedRelayEntry({
        secretKey,
        relayUrl: 'wss://my-relay.toon.example.com',
        publicRelays: ['wss://relay.damus.io'],
        metadata: { region: 'us-east', version: '1.0.0', services: ['relay'] },
      });

      // Assert -- event was published
      expect(result.publishedTo).toBe(1);

      // Assert -- find the EVENT message sent over the WebSocket
      const eventMsg = sentMessages.find((msg) => {
        const parsed = JSON.parse(msg) as unknown[];
        return parsed[0] === 'EVENT';
      });
      expect(eventMsg).toBeDefined();

      const parsed = JSON.parse(eventMsg!) as unknown[];
      const event = parsed[1] as NostrEvent;

      // Assert -- event kind is 10036
      expect(event.kind).toBe(SEED_RELAY_LIST_KIND);

      // Assert -- content contains the node's URL and derived pubkey
      const content = JSON.parse(event.content) as SeedRelayEntry[];
      expect(content).toHaveLength(1);
      expect(content[0]!.url).toBe('wss://my-relay.toon.example.com');
      expect(content[0]!.pubkey).toBe(expectedPubkey);

      // Assert -- metadata is included
      expect(content[0]!.metadata).toEqual({
        region: 'us-east',
        version: '1.0.0',
        services: ['relay'],
      });
    });

    it('publishes to multiple public relays', async () => {
      // Arrange
      webSocketConstructorBehavior = 'success';
      const secretKey = generateSecretKey();

      // Act
      const result = await publishSeedRelayEntry({
        secretKey,
        relayUrl: 'wss://my-relay.example.com',
        publicRelays: [
          'wss://relay1.example.com',
          'wss://relay2.example.com',
          'wss://relay3.example.com',
        ],
      });

      // Assert -- published to all 3 relays
      expect(result.publishedTo).toBe(3);
    });
  });

  // --------------------------------------------------------------------------
  // AC #2 GAP: Error message includes counts of tried seeds and events
  // --------------------------------------------------------------------------
  describe('Exhaustion error message detail (AC #2)', () => {
    it('error message includes count of tried seed relays and kind:10036 events', async () => {
      // Arrange -- public relay returns 3 seed entries, all fail to connect
      const seedEntries: SeedRelayEntry[] = [
        { url: 'wss://fail-1.example.com', pubkey: 'aa'.repeat(32) },
        { url: 'wss://fail-2.example.com', pubkey: 'bb'.repeat(32) },
        { url: 'wss://fail-3.example.com', pubkey: 'cc'.repeat(32) },
      ];
      const seedRelayEvent = createSeedRelayEvent(seedEntries);

      let callCount = 0;
      customWebSocketFactory = (url: string) => {
        callCount++;
        if (callCount === 1) {
          // Public relay returns kind:10036
          const ws = new MockWebSocket(url);
          ws._setKindResponses(SEED_RELAY_LIST_KIND, [seedRelayEvent]);
          return ws;
        }
        // All seed relay connections fail
        return new FailingMockWebSocket(url) as unknown as MockWebSocket;
      };
      webSocketConstructorBehavior = 'custom';

      const config = createDiscoveryConfig({
        publicRelays: ['wss://relay.damus.io'],
        connectionTimeout: 500,
        queryTimeout: 500,
      });
      const discovery = new SeedRelayDiscovery(config);

      // Act & Assert
      try {
        await discovery.discover();
        expect.fail('Should have thrown PeerDiscoveryError');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(PeerDiscoveryError);
        const msg = (err as Error).message;
        // The error message should include the count of seed relays tried
        expect(msg).toContain('3 seed relays');
        // The error message should include the count of kind:10036 events
        expect(msg).toContain('kind:10036 events');
      }

      await discovery.close();
    });

    it('error message covers zero seed entries from public relays', async () => {
      // Arrange -- public relay returns no kind:10036 events
      customWebSocketFactory = (_url: string) => {
        const ws = new MockWebSocket(_url);
        ws._setKindResponses(SEED_RELAY_LIST_KIND, []); // empty list
        return ws;
      };
      webSocketConstructorBehavior = 'custom';

      const config = createDiscoveryConfig({
        publicRelays: ['wss://relay.damus.io'],
        connectionTimeout: 500,
        queryTimeout: 500,
      });
      const discovery = new SeedRelayDiscovery(config);

      // Act & Assert
      try {
        await discovery.discover();
        expect.fail('Should have thrown PeerDiscoveryError');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(PeerDiscoveryError);
        const msg = (err as Error).message;
        expect(msg).toContain('0 seed relays');
        expect(msg).toContain('0 kind:10036 events');
      }

      await discovery.close();
    });
  });

  // --------------------------------------------------------------------------
  // AC #1 GAP: Deduplication of seed relay entries by URL
  // --------------------------------------------------------------------------
  describe('Seed relay deduplication (AC #1)', () => {
    it('deduplicates seed entries by URL when multiple kind:10036 events return the same relay', async () => {
      // Arrange -- two kind:10036 events containing the same seed relay URL
      const entries1: SeedRelayEntry[] = [
        { url: 'wss://shared-seed.example.com', pubkey: 'aa'.repeat(32) },
        { url: 'wss://unique-seed-1.example.com', pubkey: 'bb'.repeat(32) },
      ];
      const entries2: SeedRelayEntry[] = [
        { url: 'wss://shared-seed.example.com', pubkey: 'aa'.repeat(32) }, // duplicate URL
        { url: 'wss://unique-seed-2.example.com', pubkey: 'cc'.repeat(32) },
      ];
      const event1 = createSeedRelayEvent(entries1, {
        id: 'e1'.padEnd(64, '0'),
      });
      const event2 = createSeedRelayEvent(entries2, {
        id: 'e2'.padEnd(64, '0'),
      });
      const peerInfoEvent = createIlpPeerInfoEvent('dd'.repeat(32));

      // Track which seed URLs are attempted
      const attemptedUrls: string[] = [];
      let callCount = 0;
      customWebSocketFactory = (url: string) => {
        callCount++;
        if (callCount === 1) {
          // Public relay returns 2 kind:10036 events with overlapping entries
          const ws = new MockWebSocket(url);
          ws._setKindResponses(SEED_RELAY_LIST_KIND, [event1, event2]);
          return ws;
        }
        // Track seed relay connection attempts
        attemptedUrls.push(url);
        const ws = new MockWebSocket(url);
        ws._setKindResponses(ILP_PEER_INFO_KIND, [peerInfoEvent]);
        return ws;
      };
      webSocketConstructorBehavior = 'custom';

      const config = createDiscoveryConfig();
      const discovery = new SeedRelayDiscovery(config);

      // Act
      const result = await discovery.discover();

      // Assert -- should connect to the first seed and stop (dedup means
      // shared-seed.example.com appears only once in the deduped list)
      expect(result.seedRelaysConnected).toBe(1);
      // The attempted URL should be the first unique seed (shared-seed)
      expect(attemptedUrls[0]).toBe('wss://shared-seed.example.com');

      await discovery.close();
    });
  });

  // --------------------------------------------------------------------------
  // GAP: close() properly cleans up WebSocket connections
  // --------------------------------------------------------------------------
  describe('SeedRelayDiscovery.close() cleanup', () => {
    it('closes all open WebSocket connections', async () => {
      // Arrange -- perform a successful discovery
      const seedEntries = createSeedRelayList(1);
      const seedRelayEvent = createSeedRelayEvent(seedEntries);
      const peerInfoEvent = createIlpPeerInfoEvent('ab'.repeat(32));

      let callCount = 0;
      customWebSocketFactory = (_url: string) => {
        callCount++;
        const ws = new MockWebSocket(_url);
        if (callCount === 1) {
          ws._setKindResponses(SEED_RELAY_LIST_KIND, [seedRelayEvent]);
        } else {
          ws._setKindResponses(ILP_PEER_INFO_KIND, [peerInfoEvent]);
        }
        return ws;
      };
      webSocketConstructorBehavior = 'custom';

      const config = createDiscoveryConfig();
      const discovery = new SeedRelayDiscovery(config);
      await discovery.discover();

      // Act
      await discovery.close();

      // Assert -- all tracked WebSocket instances should be closed
      for (const ws of mockWebSocketInstances) {
        expect(ws.readyState).toBe(3); // CLOSED
      }
    });

    it('close() is safe to call multiple times', async () => {
      const config = createDiscoveryConfig();
      const discovery = new SeedRelayDiscovery(config);

      // Act & Assert -- should not throw
      await discovery.close();
      await discovery.close();
    });
  });

  // --------------------------------------------------------------------------
  // AC #1 GAP: Discovery from multiple public relays
  // --------------------------------------------------------------------------
  describe('Multiple public relays (AC #1)', () => {
    it('queries all configured public relays for kind:10036 events', async () => {
      // Arrange -- two public relays, each returning different seed entries
      const seedEntries1: SeedRelayEntry[] = [
        { url: 'wss://seed-from-relay1.example.com', pubkey: 'aa'.repeat(32) },
      ];
      const seedEntries2: SeedRelayEntry[] = [
        { url: 'wss://seed-from-relay2.example.com', pubkey: 'bb'.repeat(32) },
      ];
      const event1 = createSeedRelayEvent(seedEntries1, {
        id: 'r1'.padEnd(64, '0'),
      });
      const event2 = createSeedRelayEvent(seedEntries2, {
        id: 'r2'.padEnd(64, '0'),
      });
      const peerInfoEvent = createIlpPeerInfoEvent('cc'.repeat(32));

      const connectedUrls: string[] = [];
      customWebSocketFactory = (url: string) => {
        connectedUrls.push(url);
        const ws = new MockWebSocket(url);

        if (url === 'wss://public-relay-1.example.com') {
          ws._setKindResponses(SEED_RELAY_LIST_KIND, [event1]);
        } else if (url === 'wss://public-relay-2.example.com') {
          ws._setKindResponses(SEED_RELAY_LIST_KIND, [event2]);
        } else {
          // Seed relay connections
          ws._setKindResponses(ILP_PEER_INFO_KIND, [peerInfoEvent]);
        }
        return ws;
      };
      webSocketConstructorBehavior = 'custom';

      const config = createDiscoveryConfig({
        publicRelays: [
          'wss://public-relay-1.example.com',
          'wss://public-relay-2.example.com',
        ],
      });
      const discovery = new SeedRelayDiscovery(config);

      // Act
      const result = await discovery.discover();

      // Assert -- both public relays were queried
      expect(connectedUrls).toContain('wss://public-relay-1.example.com');
      expect(connectedUrls).toContain('wss://public-relay-2.example.com');
      // Assert -- discovery succeeded with peers from one of the seed relays
      expect(result.seedRelaysConnected).toBe(1);
      expect(result.discoveredPeers).toHaveLength(1);

      await discovery.close();
    });
  });

  // --------------------------------------------------------------------------
  // AC #1 GAP: IlpPeerInfo.pubkey set from event envelope, not content
  // --------------------------------------------------------------------------
  describe('IlpPeerInfo pubkey from event envelope (AC #1)', () => {
    it('sets discovered peer pubkey from the kind:10032 event pubkey field, not content', async () => {
      // Arrange -- kind:10032 event where content does NOT have pubkey,
      // but the outer event.pubkey is set
      const eventPubkey = 'ee'.repeat(32);
      const seedEntries = createSeedRelayList(1);
      const seedRelayEvent = createSeedRelayEvent(seedEntries);
      const peerInfoEvent = createIlpPeerInfoEvent(eventPubkey, {
        ilpAddress: 'g.toon.peer1',
        btpEndpoint: 'wss://btp.peer1.example.com',
      });

      let callCount = 0;
      customWebSocketFactory = (_url: string) => {
        callCount++;
        const ws = new MockWebSocket(_url);
        if (callCount === 1) {
          ws._setKindResponses(SEED_RELAY_LIST_KIND, [seedRelayEvent]);
        } else {
          ws._setKindResponses(ILP_PEER_INFO_KIND, [peerInfoEvent]);
        }
        return ws;
      };
      webSocketConstructorBehavior = 'custom';

      const config = createDiscoveryConfig();
      const discovery = new SeedRelayDiscovery(config);

      // Act
      const result = await discovery.discover();

      // Assert -- pubkey comes from the event envelope, not parsed from content
      expect(result.discoveredPeers).toHaveLength(1);
      expect(result.discoveredPeers[0]!.pubkey).toBe(eventPubkey);
      // Also verify the ILP peer info fields are correct
      expect(result.discoveredPeers[0]!.ilpAddress).toBe('g.toon.peer1');
      expect(result.discoveredPeers[0]!.btpEndpoint).toBe(
        'wss://btp.peer1.example.com'
      );

      await discovery.close();
    });
  });

  // --------------------------------------------------------------------------
  // GAP: publishSeedRelayEntry partial failure (some relays unreachable)
  // --------------------------------------------------------------------------
  describe('publishSeedRelayEntry - partial failure', () => {
    it('returns correct count when some public relays are unreachable', async () => {
      // Arrange -- 3 public relays, one fails to connect
      customWebSocketFactory = (url: string) => {
        if (url === 'wss://failing-relay.example.com') {
          return new FailingMockWebSocket(url) as unknown as MockWebSocket;
        }
        return new MockWebSocket(url);
      };
      webSocketConstructorBehavior = 'custom';

      const secretKey = generateSecretKey();

      // Act
      const result = await publishSeedRelayEntry({
        secretKey,
        relayUrl: 'wss://my-relay.example.com',
        publicRelays: [
          'wss://good-relay-1.example.com',
          'wss://failing-relay.example.com',
          'wss://good-relay-2.example.com',
        ],
      });

      // Assert -- only 2 of 3 relays succeeded
      expect(result.publishedTo).toBe(2);
      // Assert -- event ID is still valid
      expect(result.eventId).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // --------------------------------------------------------------------------
  // GAP: Empty publicRelays configuration
  // --------------------------------------------------------------------------
  describe('SeedRelayDiscovery - empty publicRelays', () => {
    it('throws PeerDiscoveryError when publicRelays is empty', async () => {
      // Arrange -- no public relays configured
      const config = createDiscoveryConfig({
        publicRelays: [],
      });
      const discovery = new SeedRelayDiscovery(config);

      // Act & Assert -- should throw because no relays to query
      try {
        await discovery.discover();
        expect.fail('Should have thrown PeerDiscoveryError');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(PeerDiscoveryError);
        expect((err as Error).message).toContain('0 seed relays');
      }

      await discovery.close();
    });
  });

  // --------------------------------------------------------------------------
  // GAP: Public relay connection failure during discovery
  // --------------------------------------------------------------------------
  describe('SeedRelayDiscovery - all public relays unreachable', () => {
    it('throws PeerDiscoveryError when all public relays fail to connect', async () => {
      // Arrange -- all public relays fail
      webSocketConstructorBehavior = 'fail';

      const config = createDiscoveryConfig({
        publicRelays: [
          'wss://unreachable-1.example.com',
          'wss://unreachable-2.example.com',
        ],
      });
      const discovery = new SeedRelayDiscovery(config);

      // Act & Assert
      try {
        await discovery.discover();
        expect.fail('Should have thrown PeerDiscoveryError');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(PeerDiscoveryError);
        // No kind:10036 events received because no public relays connected
        expect((err as Error).message).toContain('0 seed relays');
        expect((err as Error).message).toContain('0 kind:10036 events');
      }

      await discovery.close();
    });
  });

  // --------------------------------------------------------------------------
  // T-3.4-12 [P3]: E2E stub (deferred, requires genesis infrastructure)
  // --------------------------------------------------------------------------
  describe('E2E - Seed relay discovery with live genesis node (T-3.4-12)', () => {
    it.skip('[P3] seed relay discovery E2E with live genesis node', async () => {
      // This test requires a running genesis node and is deferred to
      // Epic 3 E2E test suite. It validates the full flow:
      // 1. Genesis node publishes kind:10036 to a public relay
      // 2. New node discovers seed relay via kind:10036
      // 3. New node connects to seed relay and subscribes to kind:10032
      // 4. New node discovers peers and registers with BootstrapService
      //
      // Prerequisites:
      // - SDK E2E infra running (./scripts/sdk-e2e-infra.sh up)
      // - Public Nostr relay accessible
      // - E2E test infrastructure available
      expect(true).toBe(false); // Placeholder -- implement when infra is ready
    });
  });
});

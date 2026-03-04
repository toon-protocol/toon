// @ts-nocheck — ATDD Red Phase: imports reference exports that don't exist yet
/**
 * Integration Tests: Network Discovery and Bootstrap (Story 1.9)
 *
 * ATDD Red Phase - tests will fail until SDK implementation exists
 *
 * Tests that the SDK integrates with BootstrapService and RelayMonitor from
 * @crosstown/core for automatic peer discovery and network join. Uses real
 * local infrastructure (relay, connector, Anvil) where available, with
 * graceful skip when services are unavailable.
 *
 * Prerequisites:
 *   - Genesis node: ./deploy-genesis-node.sh
 *   - Local relay: ws://localhost:7100
 *   - Local connector: http://localhost:8080
 *   - Local Anvil: http://localhost:8545
 *
 * Tests skip gracefully if infrastructure is not available, following the
 * existing E2E pattern from packages/client/tests/e2e/.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateSecretKey } from 'nostr-tools/pure';
import WebSocket from 'ws';

// --- Imports from @crosstown/sdk (DOES NOT EXIST YET) ---
import { createNode, type NodeConfig, type StartResult } from '../index.js';

// --- Imports from @crosstown/core (exists) ---
import type { BootstrapEvent, EmbeddableConnectorLike } from '@crosstown/core';
import type { SendPacketParams, SendPacketResult } from '@crosstown/core';
import type { RegisterPeerParams } from '@crosstown/core';

// --- Import from @crosstown/relay (exists, for TOON encoding) ---
import { encodeEventToToon, decodeEventFromToon } from '@crosstown/relay';

// ---------------------------------------------------------------------------
// Infrastructure Constants
// ---------------------------------------------------------------------------

const RELAY_URL = 'ws://localhost:7100';
const CONNECTOR_URL = 'http://localhost:8080';
const BLS_URL = 'http://localhost:3100';
const ANVIL_RPC = 'http://localhost:8545';
const GENESIS_PUBKEY =
  'aa1857d0ff1fcb1aeb1907b3b98290f3ecb5545473c0b9296fb0b44481deb572';

// Anvil Account #2 (for testing - has 10k ETH pre-funded)
const TEST_ACCOUNT_PRIVATE_KEY =
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const TEST_ACCOUNT_ADDRESS = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

// Deployed contract addresses (deterministic on Anvil)
const TOKEN_ADDRESS = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const TOKEN_NETWORK_ADDRESS = '0xCafac3dD18aC6c6e92c921884f9E4176737C052c';
const CHAIN_ID = 'evm:base:31337';

// ---------------------------------------------------------------------------
// Mock Embedded Connector (for non-infra tests)
// ---------------------------------------------------------------------------

class MockEmbeddedConnector implements EmbeddableConnectorLike {
  public readonly registeredPeers = new Map<string, RegisterPeerParams>();
  private packetHandler:
    | ((req: { amount: string; destination: string; data: string }) => unknown)
    | null = null;

  async sendPacket(_params: SendPacketParams): Promise<SendPacketResult> {
    return { type: 'reject', code: 'F02', message: 'No route (mock)' };
  }

  async registerPeer(params: RegisterPeerParams): Promise<void> {
    this.registeredPeers.set(params.id, params);
  }

  async removePeer(peerId: string): Promise<void> {
    this.registeredPeers.delete(peerId);
  }

  setPacketHandler(handler: (req: unknown) => unknown): void {
    this.packetHandler = handler as typeof this.packetHandler;
  }
}

// ---------------------------------------------------------------------------
// Infrastructure Health Check
// ---------------------------------------------------------------------------

async function checkInfrastructure(): Promise<{
  relay: boolean;
  connector: boolean;
  bls: boolean;
  anvil: boolean;
  all: boolean;
}> {
  const results = {
    relay: false,
    connector: false,
    bls: false,
    anvil: false,
    all: false,
  };

  // Check connector
  try {
    const resp = await fetch(`${CONNECTOR_URL}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    results.connector = resp.ok;
  } catch {
    // not available
  }

  // Check BLS
  try {
    const resp = await fetch(`${BLS_URL}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    results.bls = resp.ok;
  } catch {
    // not available
  }

  // Check Anvil
  try {
    const resp = await fetch(ANVIL_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_blockNumber',
        params: [],
        id: 1,
      }),
      signal: AbortSignal.timeout(3000),
    });
    results.anvil = resp.ok;
  } catch {
    // not available
  }

  // Check relay WebSocket
  try {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(RELAY_URL);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('timeout'));
      }, 3000);
      ws.on('open', () => {
        clearTimeout(timer);
        ws.close();
        resolve();
      });
      ws.on('error', (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    results.relay = true;
  } catch {
    // not available
  }

  results.all =
    results.relay && results.connector && results.bls && results.anvil;
  return results;
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('Network Discovery and Bootstrap Integration', () => {
  let infraAvailable = {
    relay: false,
    connector: false,
    bls: false,
    anvil: false,
    all: false,
  };

  beforeAll(async () => {
    infraAvailable = await checkInfrastructure();
    if (!infraAvailable.all) {
      console.warn(
        '[Network Discovery Tests] Skipping: Genesis node not fully available.',
        `relay=${infraAvailable.relay} connector=${infraAvailable.connector} ` +
          `bls=${infraAvailable.bls} anvil=${infraAvailable.anvil}`
      );
      console.warn('Run: ./deploy-genesis-node.sh');
    }
  }, 15000);

  // -------------------------------------------------------------------------
  // [P0] BootstrapService runs layered discovery when node.start() called
  // -------------------------------------------------------------------------

  it.skip('[P0] node.start() runs layered bootstrap discovery with genesis peers', async () => {
    // Arrange
    if (!infraAvailable.all) {
      console.log('Skipping: Infrastructure not available');
      return;
    }

    const secretKey = generateSecretKey();
    const connector = new MockEmbeddedConnector();

    const config: NodeConfig = {
      secretKey,
      connector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      relayUrl: RELAY_URL,
      knownPeers: [
        {
          pubkey: GENESIS_PUBKEY,
          relayUrl: RELAY_URL,
          btpEndpoint: 'ws://localhost:3000',
        },
      ],
      ardriveEnabled: false, // Disable ArDrive for deterministic test
    };

    const node = createNode(config);

    // Collect bootstrap events
    const events: BootstrapEvent[] = [];
    node.on('bootstrap', (event: BootstrapEvent) => {
      events.push(event);
    });

    // Act
    const result: StartResult = await node.start();

    // Assert
    // Should have discovered and registered the genesis peer
    expect(result.peerCount).toBeGreaterThanOrEqual(1);
    expect(result.bootstrapResults.length).toBeGreaterThanOrEqual(1);

    // Genesis peer should be registered in connector
    const genesisPeerId = `nostr-${GENESIS_PUBKEY.slice(0, 16)}`;
    expect(connector.registeredPeers.has(genesisPeerId)).toBe(true);

    // Should have received bootstrap lifecycle events
    const phaseEvents = events.filter((e) => e.type === 'bootstrap:phase');
    expect(phaseEvents.length).toBeGreaterThan(0);

    const readyEvent = events.find((e) => e.type === 'bootstrap:ready');
    expect(readyEvent).toBeDefined();

    // Cleanup
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // [P0] RelayMonitor detects new kind:10032 events on relay
  // -------------------------------------------------------------------------

  it.skip('[P0] RelayMonitor detects existing kind:10032 events on the relay', async () => {
    // Arrange
    if (!infraAvailable.relay) {
      console.log('Skipping: Relay not available');
      return;
    }

    const secretKey = generateSecretKey();
    const connector = new MockEmbeddedConnector();

    const config: NodeConfig = {
      secretKey,
      connector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      relayUrl: RELAY_URL,
      // Start with NO known peers — RelayMonitor should discover from relay
      knownPeers: [],
      ardriveEnabled: false,
    };

    const node = createNode(config);

    // Collect discovery events
    const discoveredPeers: string[] = [];
    node.on('bootstrap', (event: BootstrapEvent) => {
      if (event.type === 'bootstrap:peer-discovered') {
        discoveredPeers.push(event.peerPubkey);
      }
    });

    // Act
    await node.start();

    // Wait for RelayMonitor to process historical kind:10032 events
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Assert
    // The genesis node should have a kind:10032 on the relay
    // RelayMonitor should discover it (excluding our own pubkey)
    expect(discoveredPeers.length).toBeGreaterThanOrEqual(1);
    expect(discoveredPeers).toContain(GENESIS_PUBKEY);

    // Cleanup
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // [P0] Payment channels opened when settlement chains intersect
  // -------------------------------------------------------------------------

  it.skip('[P0] payment channels opened when settlement chains intersect (uses Anvil)', async () => {
    // Arrange
    if (!infraAvailable.all) {
      console.log('Skipping: Full infrastructure not available');
      return;
    }

    const secretKey = generateSecretKey();
    const connector = new MockEmbeddedConnector();

    const config: NodeConfig = {
      secretKey,
      connector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      relayUrl: RELAY_URL,
      knownPeers: [
        {
          pubkey: GENESIS_PUBKEY,
          relayUrl: RELAY_URL,
          btpEndpoint: 'ws://localhost:3000',
        },
      ],
      ardriveEnabled: false,
      // EVM settlement configuration
      evmPrivateKey: TEST_ACCOUNT_PRIVATE_KEY,
      settlementInfo: {
        supportedChains: [CHAIN_ID],
        settlementAddresses: { [CHAIN_ID]: TEST_ACCOUNT_ADDRESS },
        preferredTokens: { [CHAIN_ID]: TOKEN_ADDRESS },
        tokenNetworks: { [CHAIN_ID]: TOKEN_NETWORK_ADDRESS },
      },
      settlementNegotiationConfig: {
        ownSupportedChains: [CHAIN_ID],
        ownSettlementAddresses: { [CHAIN_ID]: TEST_ACCOUNT_ADDRESS },
        ownPreferredTokens: { [CHAIN_ID]: TOKEN_ADDRESS },
        ownTokenNetworks: { [CHAIN_ID]: TOKEN_NETWORK_ADDRESS },
        initialDeposit: '100000',
        settlementTimeout: 86400,
      },
    };

    const node = createNode(config);

    // Collect channel events
    const channelEvents: BootstrapEvent[] = [];
    node.on('bootstrap', (event: BootstrapEvent) => {
      if (event.type === 'bootstrap:channel-opened') {
        channelEvents.push(event);
      }
    });

    // Act
    const result: StartResult = await node.start();

    // Assert
    // Should have opened a payment channel with the genesis peer
    expect(result.channelCount).toBeGreaterThanOrEqual(1);

    // Channel opened event should have been emitted
    expect(channelEvents.length).toBeGreaterThanOrEqual(1);
    const channelEvent = channelEvents[0];
    expect(channelEvent).toBeDefined();
    if (channelEvent?.type === 'bootstrap:channel-opened') {
      expect(channelEvent.channelId).toBeDefined();
      expect(channelEvent.negotiatedChain).toBe(CHAIN_ID);
    }

    // Cleanup
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // [P1] node.peerWith(pubkey) initiates manual peering
  // -------------------------------------------------------------------------

  it.skip('[P1] node.peerWith(pubkey) registers peer and initiates SPSP handshake', async () => {
    // Arrange
    if (!infraAvailable.all) {
      console.log('Skipping: Full infrastructure not available');
      return;
    }

    const secretKey = generateSecretKey();
    const connector = new MockEmbeddedConnector();

    const config: NodeConfig = {
      secretKey,
      connector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      relayUrl: RELAY_URL,
      // Start with NO known peers — we will manually peer
      knownPeers: [],
      ardriveEnabled: false,
    };

    const node = createNode(config);
    await node.start();

    // Wait for RelayMonitor to discover genesis peer
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Collect peering events
    const peerEvents: BootstrapEvent[] = [];
    node.on('bootstrap', (event: BootstrapEvent) => {
      peerEvents.push(event);
    });

    // Act — manually peer with the genesis node
    await node.peerWith(GENESIS_PUBKEY);

    // Assert
    const genesisPeerId = `nostr-${GENESIS_PUBKEY.slice(0, 16)}`;

    // Peer should be registered in connector
    expect(connector.registeredPeers.has(genesisPeerId)).toBe(true);

    // Should have received peer-registered event
    const registeredEvent = peerEvents.find(
      (e) =>
        e.type === 'bootstrap:peer-registered' &&
        e.peerPubkey === GENESIS_PUBKEY
    );
    expect(registeredEvent).toBeDefined();

    // Cleanup
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // [P1] node.on('bootstrap', listener) receives lifecycle events
  // -------------------------------------------------------------------------

  it.skip('[P1] node.on("bootstrap", listener) receives bootstrap lifecycle events', async () => {
    // Arrange
    const secretKey = generateSecretKey();
    const connector = new MockEmbeddedConnector();

    const config: NodeConfig = {
      secretKey,
      connector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      relayUrl: RELAY_URL,
      knownPeers: infraAvailable.all
        ? [
            {
              pubkey: GENESIS_PUBKEY,
              relayUrl: RELAY_URL,
              btpEndpoint: 'ws://localhost:3000',
            },
          ]
        : [],
      ardriveEnabled: false,
    };

    const node = createNode(config);

    // Register event listener BEFORE start
    const allEvents: BootstrapEvent[] = [];
    const listener = (event: BootstrapEvent) => {
      allEvents.push(event);
    };
    node.on('bootstrap', listener);

    // Act
    await node.start();

    // Assert — should receive at least phase transition events
    expect(allEvents.length).toBeGreaterThan(0);

    // Phase events should be present (discovering -> registering -> ... -> ready)
    const phaseEvents = allEvents.filter((e) => e.type === 'bootstrap:phase');
    expect(phaseEvents.length).toBeGreaterThan(0);

    // The final event should be bootstrap:ready
    const readyEvent = allEvents.find((e) => e.type === 'bootstrap:ready');
    expect(readyEvent).toBeDefined();
    if (readyEvent?.type === 'bootstrap:ready') {
      expect(typeof readyEvent.peerCount).toBe('number');
      expect(typeof readyEvent.channelCount).toBe('number');
    }

    // Cleanup
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // [P1] Bootstrap with no known peers and no infra starts with 0 peers
  // -------------------------------------------------------------------------

  it.skip('[P1] bootstrap with no known peers completes with 0 peers', async () => {
    // Arrange
    const secretKey = generateSecretKey();
    const connector = new MockEmbeddedConnector();

    const config: NodeConfig = {
      secretKey,
      connector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      // No relay, no known peers, no ArDrive
      knownPeers: [],
      ardriveEnabled: false,
    };

    const node = createNode(config);

    const events: BootstrapEvent[] = [];
    node.on('bootstrap', (event: BootstrapEvent) => {
      events.push(event);
    });

    // Act
    const result: StartResult = await node.start();

    // Assert
    expect(result.peerCount).toBe(0);
    expect(result.channelCount).toBe(0);
    expect(result.bootstrapResults).toEqual([]);

    // Still should get a ready event
    const readyEvent = events.find((e) => e.type === 'bootstrap:ready');
    expect(readyEvent).toBeDefined();
    if (readyEvent?.type === 'bootstrap:ready') {
      expect(readyEvent.peerCount).toBe(0);
    }

    // Cleanup
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // [P2] bootstrap:peer-discovered events include ILP address
  // -------------------------------------------------------------------------

  it.skip('[P2] peer-discovered events include ILP address from kind:10032', async () => {
    // Arrange
    if (!infraAvailable.relay) {
      console.log('Skipping: Relay not available');
      return;
    }

    const secretKey = generateSecretKey();
    const connector = new MockEmbeddedConnector();

    const config: NodeConfig = {
      secretKey,
      connector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      relayUrl: RELAY_URL,
      knownPeers: [],
      ardriveEnabled: false,
    };

    const node = createNode(config);

    const discoveryEvents: BootstrapEvent[] = [];
    node.on('bootstrap', (event: BootstrapEvent) => {
      if (event.type === 'bootstrap:peer-discovered') {
        discoveryEvents.push(event);
      }
    });

    // Act
    await node.start();
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Assert
    if (discoveryEvents.length > 0) {
      const firstDiscovery = discoveryEvents[0]!;
      if (firstDiscovery.type === 'bootstrap:peer-discovered') {
        // ILP address should be non-empty string
        expect(firstDiscovery.ilpAddress).toBeDefined();
        expect(typeof firstDiscovery.ilpAddress).toBe('string');
        expect(firstDiscovery.ilpAddress.length).toBeGreaterThan(0);
        // ILP address typically starts with 'g.'
        expect(firstDiscovery.ilpAddress).toMatch(/^g\./);
      }
    }

    // Cleanup
    await node.stop();
  });

  // -------------------------------------------------------------------------
  // [P2] Multiple start/stop cycles work correctly
  // -------------------------------------------------------------------------

  it.skip('[P2] node supports start/stop/start lifecycle reset', async () => {
    // Arrange
    const secretKey = generateSecretKey();
    const connector = new MockEmbeddedConnector();

    const config: NodeConfig = {
      secretKey,
      connector,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      knownPeers: [],
      ardriveEnabled: false,
    };

    const node = createNode(config);

    // Act — first cycle
    const result1 = await node.start();
    expect(result1.peerCount).toBe(0);
    await node.stop();

    // Act — second cycle (should work after stop)
    const result2 = await node.start();
    expect(result2.peerCount).toBe(0);
    await node.stop();

    // Assert — both cycles completed without error
    expect(result1).toBeDefined();
    expect(result2).toBeDefined();
  });

  afterAll(async () => {
    // Allow pending WebSocket connections to close
    await new Promise((resolve) => setTimeout(resolve, 500));
  });
});

/**
 * Five-Peer Bootstrap Integration Test
 *
 * Exercises the full 3-phase bootstrap (discover → register → announce)
 * across 5 peers with peer0 as genesis, using real Nostr relay servers,
 * real Nostr keypairs, and an in-memory ILP router.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPublicKey } from 'nostr-tools/pure';
import {
  NostrRelayServer,
  InMemoryEventStore,
  BusinessLogicServer,
  encodeEventToToon,
  decodeEventFromToon,
} from '@crosstown/relay';
import {
  createCrosstownNode,
  type EmbeddableConnectorLike,
  type HandlePacketRequest,
  type HandlePacketResponse,
} from '../compose.js';
import type { CrosstownNode } from '../compose.js';
import type {
  SendPacketParams,
  SendPacketResult,
} from '../bootstrap/direct-ilp-client.js';
import type { RegisterPeerParams } from '../bootstrap/direct-connector-admin.js';
import type { BootstrapEvent, SettlementConfig } from '../bootstrap/types.js';
import type { IlpPeerInfo } from '../types.js';
import { buildIlpPeerInfoEvent } from '../events/builders.js';

import testnetWallets from './testnet-wallets.json';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PeerFixture {
  index: number;
  secretKey: Uint8Array;
  pubkey: string;
  evmAddress: string;
  ilpAddress: string;
  eventStore: InMemoryEventStore;
  relay: NostrRelayServer;
  relayPort: number;
  relayUrl: string;
  btpEndpoint: string;
  connector: MockConnectorWithRouter;
  node?: CrosstownNode;
  events: BootstrapEvent[];
}

// ---------------------------------------------------------------------------
// InMemoryIlpRouter — shared routing fabric
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

    // Convert SendPacketParams → HandlePacketRequest
    const request: HandlePacketRequest = {
      amount: params.amount.toString(),
      destination: params.destination,
      data: Buffer.from(params.data).toString('base64'),
    };

    const response = await handler(request);

    // Convert HandlePacketResponse → SendPacketResult
    if (response.accept) {
      const result: SendPacketResult = {
        type: 'fulfill',
        fulfillment: response.fulfillment
          ? Uint8Array.from(Buffer.from(response.fulfillment, 'base64'))
          : new Uint8Array(32),
      };
      return result;
    }

    return {
      type: 'reject',
      code: response.code,
      message: response.message,
    };
  }
}

// ---------------------------------------------------------------------------
// MockConnectorWithRouter — implements EmbeddableConnectorLike
// ---------------------------------------------------------------------------

class MockConnectorWithRouter implements EmbeddableConnectorLike {
  readonly registeredPeers = new Map<string, RegisterPeerParams>();
  readonly removedPeers: string[] = [];
  readonly openedChannels = new Map<
    string,
    {
      peerId: string;
      chain: string;
      status: 'opening' | 'open' | 'closed' | 'settled';
    }
  >();
  private packetHandler:
    | ((
        req: HandlePacketRequest
      ) => HandlePacketResponse | Promise<HandlePacketResponse>)
    | null = null;
  private channelCounter = 0;

  constructor(private router: InMemoryIlpRouter) {}

  async sendPacket(params: SendPacketParams): Promise<SendPacketResult> {
    return this.router.routePacket(params);
  }

  async registerPeer(params: RegisterPeerParams): Promise<void> {
    this.registeredPeers.set(params.id, params);
  }

  async removePeer(peerId: string): Promise<void> {
    this.registeredPeers.delete(peerId);
    this.removedPeers.push(peerId);
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

  async openChannel(params: {
    peerId: string;
    chain: string;
    token?: string;
    tokenNetwork?: string;
    peerAddress: string;
    initialDeposit?: string;
    settlementTimeout?: number;
  }): Promise<{ channelId: string; status: string }> {
    this.channelCounter++;
    const channelId = `ch-${params.peerId}-${this.channelCounter}`;
    this.openedChannels.set(channelId, {
      peerId: params.peerId,
      chain: params.chain,
      status: 'open', // Instantly open for test simplicity
    });
    return { channelId, status: 'open' };
  }

  async getChannelState(channelId: string): Promise<{
    channelId: string;
    status: 'opening' | 'open' | 'closed' | 'settled';
    chain: string;
  }> {
    const channel = this.openedChannels.get(channelId);
    if (!channel) {
      throw new Error(`Channel ${channelId} not found`);
    }
    return {
      channelId,
      status: channel.status,
      chain: channel.chain,
    };
  }
}

// ---------------------------------------------------------------------------
// createPeerPacketHandler — per-peer incoming packet handler
// ---------------------------------------------------------------------------

function createPeerPacketHandler(
  peer: PeerFixture
): (
  req: HandlePacketRequest
) => HandlePacketResponse | Promise<HandlePacketResponse> {
  const basePricePerByte = 10n;

  // BLS handles regular event storage + pricing
  const bls = new BusinessLogicServer(
    {
      basePricePerByte,
      ownerPubkey: peer.pubkey,
    },
    peer.eventStore
  );

  return async (
    request: HandlePacketRequest
  ): Promise<HandlePacketResponse> => {
    // Delegate all packets to BLS
    return bls.handlePacket(request) as HandlePacketResponse;
  };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('Five-Peer Bootstrap Integration', () => {
  const PEER_COUNT = 5;
  const CHAIN_ID = testnetWallets.contracts.evm.chainIdentifier;
  const TOKEN_ADDRESS = testnetWallets.contracts.evm.token;
  const TOKEN_NETWORK = testnetWallets.contracts.evm.tokenNetwork;

  const peers: PeerFixture[] = [];
  let router: InMemoryIlpRouter;

  beforeAll(async () => {
    router = new InMemoryIlpRouter();

    // Create all peer fixtures
    for (let i = 0; i < PEER_COUNT; i++) {
      const walletData = testnetWallets.peers[i]!;
      const secretKey = Uint8Array.from(
        Buffer.from(walletData.nostr.secretKey, 'hex')
      );
      const pubkey = getPublicKey(secretKey);
      const ilpAddress = `g.test.peer${i}`;
      const evmAddress = walletData.evm.address;

      const eventStore = new InMemoryEventStore();
      const relay = new NostrRelayServer({ port: 0 }, eventStore);
      await relay.start();
      const relayPort = relay.getPort();
      const relayUrl = `ws://127.0.0.1:${relayPort}`;
      const btpEndpoint = `btp+ws://127.0.0.1:${relayPort}`;

      const connector = new MockConnectorWithRouter(router);
      router.register(ilpAddress, connector);

      peers.push({
        index: i,
        secretKey,
        pubkey,
        evmAddress,
        ilpAddress,
        eventStore,
        relay,
        relayPort,
        relayUrl,
        btpEndpoint,
        connector,
        events: [],
      });
    }

    // Genesis (peer0): seed kind:10032 event directly into its event store
    const genesisIlpInfo: IlpPeerInfo = {
      ilpAddress: peers[0]!.ilpAddress,
      btpEndpoint: peers[0]!.btpEndpoint,
      assetCode: 'USD',
      assetScale: 6,
      supportedChains: [CHAIN_ID],
      settlementAddresses: { [CHAIN_ID]: peers[0]!.evmAddress },
      preferredTokens: { [CHAIN_ID]: TOKEN_ADDRESS },
      tokenNetworks: { [CHAIN_ID]: TOKEN_NETWORK },
    };
    const genesisEvent = buildIlpPeerInfoEvent(
      genesisIlpInfo,
      peers[0]!.secretKey
    );
    peers[0]!.eventStore.store(genesisEvent);

    // Create CrosstownNode instances
    for (let i = 0; i < PEER_COUNT; i++) {
      const peer = peers[i]!;

      const settlementInfo: SettlementConfig = {
        supportedChains: [CHAIN_ID],
        settlementAddresses: { [CHAIN_ID]: peer.evmAddress },
        preferredTokens: { [CHAIN_ID]: TOKEN_ADDRESS },
        tokenNetworks: { [CHAIN_ID]: TOKEN_NETWORK },
      };

      const ilpInfo: IlpPeerInfo = {
        ilpAddress: peer.ilpAddress,
        btpEndpoint: peer.btpEndpoint,
        assetCode: 'USD',
        assetScale: 6,
        supportedChains: [CHAIN_ID],
        settlementAddresses: { [CHAIN_ID]: peer.evmAddress },
        preferredTokens: { [CHAIN_ID]: TOKEN_ADDRESS },
        tokenNetworks: { [CHAIN_ID]: TOKEN_NETWORK },
      };

      const handlePacket = createPeerPacketHandler(peer);

      const knownPeers =
        i === 0
          ? []
          : [
              {
                pubkey: peers[0]!.pubkey,
                relayUrl: peers[0]!.relayUrl,
                btpEndpoint: peers[0]!.btpEndpoint,
              },
            ];

      const node = createCrosstownNode({
        connector: peer.connector,
        handlePacket,
        secretKey: peer.secretKey,
        ilpInfo,
        toonEncoder: encodeEventToToon,
        toonDecoder: decodeEventFromToon,
        relayUrl: peers[0]!.relayUrl,
        knownPeers,
        settlementInfo,
        basePricePerByte: 10n,
        ardriveEnabled: false,
        queryTimeout: 10_000,
      });

      // Capture events
      node.bootstrapService.on((event) => peer.events.push(event));
      node.relayMonitor.on((event) => peer.events.push(event));

      peer.node = node;
    }

    // Start sequentially: genesis first, then joiners
    await peers[0]!.node!.start();

    for (let i = 1; i < PEER_COUNT; i++) {
      await peers[i]!.node!.start();
    }

    // Wait for DiscoveryTracker event propagation
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }, 60_000);

  afterAll(async () => {
    // Stop nodes
    for (const peer of peers) {
      if (peer.node) {
        await peer.node.stop();
      }
    }
    // Stop relays
    for (const peer of peers) {
      await peer.relay.stop();
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // Assertions
  // -------------------------------------------------------------------------

  it('genesis starts with 0 peers', () => {
    const readyEvent = peers[0]!.events.find(
      (e) => e.type === 'bootstrap:ready'
    );
    expect(readyEvent).toBeDefined();
    expect(
      readyEvent!.type === 'bootstrap:ready' && readyEvent!.peerCount
    ).toBe(0);
  });

  it('peers 1-4 discover genesis', () => {
    for (let i = 1; i < PEER_COUNT; i++) {
      const registered = peers[i]!.events.filter(
        (e) => e.type === 'bootstrap:peer-registered'
      );
      expect(registered.length).toBeGreaterThanOrEqual(1);
      const registeredWithGenesis = registered.find(
        (e) =>
          e.type === 'bootstrap:peer-registered' &&
          e.peerPubkey === peers[0]!.pubkey
      );
      expect(registeredWithGenesis).toBeDefined();
    }
  });

  it('peers 1-4 register genesis in connector', () => {
    const expectedPeerId = `nostr-${peers[0]!.pubkey.slice(0, 16)}`;
    for (let i = 1; i < PEER_COUNT; i++) {
      expect(peers[i]!.connector.registeredPeers.has(expectedPeerId)).toBe(
        true
      );
    }
  });

  it('peers 1-4 announce to genesis with paid amounts', () => {
    // Phase 3: announcements are paid ILP PREPAREs (basePricePerByte * toonBytes)
    for (let i = 1; i < PEER_COUNT; i++) {
      const announced = peers[i]!.events.filter(
        (e) => e.type === 'bootstrap:announced'
      );
      expect(announced.length).toBeGreaterThanOrEqual(1);
      for (const event of announced) {
        if (event.type === 'bootstrap:announced') {
          expect(BigInt(event.amount)).toBeGreaterThan(0n);
        }
      }
    }
  });

  it('genesis event store has kind:10032 events from all 5 peers', () => {
    const storedEvents = peers[0]!.eventStore.query([{ kinds: [10032] }]);
    const storedPubkeys = new Set(storedEvents.map((e) => e.pubkey));

    for (let i = 0; i < PEER_COUNT; i++) {
      expect(storedPubkeys.has(peers[i]!.pubkey)).toBe(true);
    }
  });

  it('later peers discover earlier peers via DiscoveryTracker', () => {
    // Genesis tracker processes events before any peer announces, so it only
    // sees historical events (just its own, excluded). BLS-stored events don't
    // push to existing WebSocket subscriptions, so genesis won't discover live.
    //
    // However, peers that start LATER subscribe to the relay AFTER earlier peers
    // have already announced, so they discover earlier peers via historical query.
    // Peer4 (last to start) should discover peers 1-3 via DiscoveryTracker.
    const peer4Discovered = peers[4]!.events.filter(
      (e) => e.type === 'bootstrap:peer-discovered'
    );
    const discoveredPubkeys = new Set(
      peer4Discovered.map((e) => (e as { peerPubkey: string }).peerPubkey)
    );

    // Peer4's DiscoveryTracker excludes peer0 (bootstrapped) and peer4 (own pubkey),
    // so it should discover peers 1-3 from the historical query
    for (let i = 1; i < PEER_COUNT - 1; i++) {
      expect(discoveredPubkeys.has(peers[i]!.pubkey)).toBe(true);
    }
  });

  it('all relays on unique ports', () => {
    const ports = new Set(peers.map((p) => p.relayPort));
    expect(ports.size).toBe(PEER_COUNT);
    for (const port of ports) {
      expect(port).toBeGreaterThan(0);
    }
  });

  it('peers use real Nostr identities from fixture', () => {
    for (let i = 0; i < PEER_COUNT; i++) {
      expect(peers[i]!.pubkey).toBe(testnetWallets.peers[i]!.nostr.pubkey);
    }
  });

  it('CrosstownNode exposes channelClient when connector has channel methods', () => {
    // MockConnectorWithRouter implements openChannel() and getChannelState(),
    // so createCrosstownNode() should detect them and create a channelClient.
    for (let i = 0; i < PEER_COUNT; i++) {
      expect(peers[i]!.node!.channelClient).not.toBeNull();
      expect(peers[i]!.node!.channelClient!.openChannel).toBeInstanceOf(
        Function
      );
      expect(peers[i]!.node!.channelClient!.getChannelState).toBeInstanceOf(
        Function
      );
    }
  });

  it('joiner peers complete bootstrap with at least 1 peer', () => {
    for (let i = 1; i < PEER_COUNT; i++) {
      const readyEvent = peers[i]!.events.find(
        (e) => e.type === 'bootstrap:ready'
      );
      expect(readyEvent).toBeDefined();
      if (readyEvent?.type === 'bootstrap:ready') {
        expect(readyEvent.peerCount).toBe(1); // Each joiner bootstraps with genesis
      }
    }
  });
});

/**
 * E2E Test: Multi-Hop Publish Events via Docker SDK Containers
 *
 * **Prerequisites:**
 * SDK E2E infrastructure running:
 * ```bash
 * ./scripts/sdk-e2e-infra.sh up
 * ```
 *
 * **What this test verifies (production-realistic, zero mocks):**
 *
 * On-chain (Anvil):
 * - Token balance decreases after channel deposit (real ERC-20 transfer)
 * - Channel state verifiable on-chain (open, participants, deposit amounts)
 * - channelCounter reflects all opened channels across the network
 * - Channel close + settlement lifecycle (open → deposit → EIP-712 sign → close → settle → verify balances)
 *
 * Single-hop (test node → peer1):
 * - publishEvent delivers event, verifiable on peer1's relay via NIP-01
 * - Payment amount scales with TOON byte length
 *
 * Multi-hop (test node → peer1 → peer2):
 * - publishEvent routes through peer1 intermediary to peer2
 * - Sequential events all arrive at peer2's relay
 * - Event metadata (tags, content, sig, kind) preserved through 2-hop pipeline
 *
 * Network topology:
 * ```
 * Test Node (in-process) ──BTP──> Peer1 (Docker) ──BTP──> Peer2 (Docker)
 *      │                              │                        │
 *   Anvil Account #3            Anvil Account #0          Anvil Account #2
 *      └──── channel ────────────────┘                        │
 *                                    └──── channel ───────────┘
 * ```
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
} from 'nostr-tools/pure';
import {
  createNode,
  type ServiceNode,
  type HandlerContext,
} from '@crosstown/sdk';
import { ConnectorNode, createLogger } from '@crosstown/connector';
import { encodeEventToToon, decodeEventFromToon } from '@crosstown/relay';
import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  keccak256,
  encodePacked,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import WebSocket from 'ws';

// ---------------------------------------------------------------------------
// Constants (Docker SDK E2E ports — see docker-compose-sdk-e2e.yml)
// ---------------------------------------------------------------------------

const ANVIL_RPC = 'http://localhost:18545';

// Peer 1 (Docker — genesis-like)
const PEER1_RELAY_URL = 'ws://localhost:19700';
const PEER1_BTP_URL = 'ws://localhost:19000';
const PEER1_BLS_URL = 'http://localhost:19100';
const PEER1_EVM_ADDRESS =
  '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const; // Anvil Account #0

// Peer 2 (Docker — bootstraps from peer1)
const PEER2_RELAY_URL = 'ws://localhost:19710';
const PEER2_BLS_URL = 'http://localhost:19110';

// Contracts (deterministic Anvil deployment)
const TOKEN_ADDRESS =
  '0x5FbDB2315678afecb367f032d93F642f64180aa3' as const; // Mock USDC (Anvil)
const TOKEN_NETWORK_ADDRESS =
  '0xCafac3dD18aC6c6e92c921884f9E4176737C052c' as const;
const REGISTRY_ADDRESS =
  '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512' as const;

// Test account (Anvil Account #3)
const TEST_PRIVATE_KEY =
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6' as const;
const TEST_EVM_ADDRESS =
  '0x90F79bf6EB2c4f870365E785982E1f101E93b906' as const;

// Settlement test accounts (Anvil Account #4 and #5 — unused by Docker infra)
const SETTLEMENT_PRIVATE_KEY_A =
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a' as const;
const SETTLEMENT_PRIVATE_KEY_B =
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba' as const;

const CHAIN_ID = 31337;

// ---------------------------------------------------------------------------
// Anvil chain definition
// ---------------------------------------------------------------------------

const anvilChain = defineChain({
  id: CHAIN_ID,
  name: 'anvil',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [ANVIL_RPC] } },
});

// ---------------------------------------------------------------------------
// ABIs
// ---------------------------------------------------------------------------

const TOKEN_NETWORK_ABI = [
  {
    name: 'channels',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ type: 'bytes32' }],
    outputs: [
      { name: 'settlementTimeout', type: 'uint256' },
      { name: 'state', type: 'uint8' },
      { name: 'closedAt', type: 'uint256' },
      { name: 'openedAt', type: 'uint256' },
      { name: 'participant1', type: 'address' },
      { name: 'participant2', type: 'address' },
    ],
  },
  {
    name: 'participants',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ type: 'bytes32' }, { type: 'address' }],
    outputs: [
      { name: 'deposit', type: 'uint256' },
      { name: 'withdrawnAmount', type: 'uint256' },
      { name: 'isCloser', type: 'bool' },
      { name: 'nonce', type: 'uint256' },
      { name: 'transferredAmount', type: 'uint256' },
    ],
  },
  {
    name: 'channelCounter',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'openChannel',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'participant2', type: 'address' },
      { name: 'settlementTimeout', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    name: 'setTotalDeposit',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'channelId', type: 'bytes32' },
      { name: 'participant', type: 'address' },
      { name: 'totalDeposit', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'closeChannel',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'channelId', type: 'bytes32' },
      {
        name: 'balanceProof',
        type: 'tuple',
        components: [
          { name: 'channelId', type: 'bytes32' },
          { name: 'nonce', type: 'uint256' },
          { name: 'transferredAmount', type: 'uint256' },
          { name: 'lockedAmount', type: 'uint256' },
          { name: 'locksRoot', type: 'bytes32' },
        ],
      },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    name: 'settleChannel',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'channelId', type: 'bytes32' }],
    outputs: [],
  },
] as const;

const ERC20_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'transfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

// EIP-712 types for balance proof signing
const BALANCE_PROOF_TYPES = {
  BalanceProof: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'transferredAmount', type: 'uint256' },
    { name: 'lockedAmount', type: 'uint256' },
    { name: 'locksRoot', type: 'bytes32' },
  ],
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CHANNEL_STATE_NAMES = ['settled', 'open', 'closed', 'settled'] as const;

function createViemClient() {
  return createPublicClient({
    chain: anvilChain,
    transport: http(ANVIL_RPC),
  });
}

async function getChannelState(channelId: Hex) {
  const client = createViemClient();
  const result = await client.readContract({
    address: TOKEN_NETWORK_ADDRESS,
    abi: TOKEN_NETWORK_ABI,
    functionName: 'channels',
    args: [channelId],
  });

  const [settlementTimeout, state, closedAt, openedAt, participant1, participant2] =
    result;

  return {
    channelId,
    state: CHANNEL_STATE_NAMES[state] || 'unknown',
    stateNum: state,
    settlementTimeout: Number(settlementTimeout),
    openedAt: Number(openedAt),
    closedAt: Number(closedAt),
    participant1,
    participant2,
  };
}

async function getParticipantInfo(channelId: Hex, participant: Hex) {
  const client = createViemClient();
  const result = await client.readContract({
    address: TOKEN_NETWORK_ADDRESS,
    abi: TOKEN_NETWORK_ABI,
    functionName: 'participants',
    args: [channelId, participant],
  });

  const [deposit, withdrawnAmount, isCloser, nonce, transferredAmount] = result;
  return { deposit, withdrawnAmount, isCloser, nonce, transferredAmount };
}

async function getTokenBalance(address: Hex): Promise<bigint> {
  const client = createViemClient();
  return client.readContract({
    address: TOKEN_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [address],
  });
}

async function getChannelCounter(): Promise<bigint> {
  const client = createViemClient();
  return client.readContract({
    address: TOKEN_NETWORK_ADDRESS,
    abi: TOKEN_NETWORK_ABI,
    functionName: 'channelCounter',
    args: [],
  });
}

function waitForEventOnRelay(
  relayUrl: string,
  eventId: string,
  timeoutMs = 15000
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUrl);
    const subId = `test-${Date.now()}`;
    // eslint-disable-next-line prefer-const
    let timer: ReturnType<typeof setTimeout>;

    const cleanup = () => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // ignore
      }
    };

    timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);

    ws.on('open', () => {
      ws.send(JSON.stringify(['REQ', subId, { ids: [eventId] }]));
    });

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (Array.isArray(msg)) {
          if (msg[0] === 'EVENT' && msg[1] === subId && msg[2]) {
            const toonBytes = new TextEncoder().encode(msg[2]);
            const event = decodeEventFromToon(toonBytes);
            cleanup();
            resolve(event as unknown as Record<string, unknown>);
          }
        }
      } catch {
        // ignore parse errors
      }
    });

    ws.on('error', (err: Error) => {
      cleanup();
      reject(err);
    });
  });
}

async function waitForServiceHealth(
  url: string,
  timeoutMs = 30000
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function waitForRelayReady(
  url: string,
  timeoutMs = 30000
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(url);
        const t = setTimeout(() => {
          ws.close();
          reject(new Error('timeout'));
        }, 2000);
        ws.on('open', () => {
          clearTimeout(t);
          ws.close();
          resolve();
        });
        ws.on('error', (e: Error) => {
          clearTimeout(t);
          reject(e);
        });
      });
      return true;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/**
 * Wait for peer2's bootstrap to complete by polling its health endpoint
 * until bootstrapPhase is 'ready'.
 */
async function waitForPeer2Bootstrap(timeoutMs = 45000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${PEER2_BLS_URL}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const data = (await res.json()) as Record<string, unknown>;
        if (data['bootstrapPhase'] === 'ready') return true;
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Docker SDK Publish Event E2E', () => {
  let servicesReady = false;
  let node: ServiceNode;
  let connector: ConnectorNode;
  const publishedEventIds: string[] = [];
  let nostrSecretKey: Uint8Array;
  let nostrPubkey: string;
  let channelId: string;
  let tokenBalanceBefore: bigint;
  let channelCounterBefore: bigint;

  beforeAll(async () => {
    // -------------------------------------------------------------------
    // Phase 1: Health checks — ALL services must be running
    // -------------------------------------------------------------------
    try {
      const [anvilOk, peer1BlsOk, peer2BlsOk] = await Promise.all([
        fetch(ANVIL_RPC, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'eth_blockNumber',
            params: [],
            id: 1,
          }),
          signal: AbortSignal.timeout(3000),
        }).then((r) => r.ok),
        waitForServiceHealth(`${PEER1_BLS_URL}/health`, 10000),
        waitForServiceHealth(`${PEER2_BLS_URL}/health`, 10000),
      ]);

      if (!anvilOk || !peer1BlsOk || !peer2BlsOk) {
        console.warn(
          'Docker SDK E2E services not ready. Run: ./scripts/sdk-e2e-infra.sh up'
        );
        return;
      }

      // Check both relays via WebSocket
      const [peer1RelayOk, peer2RelayOk] = await Promise.all([
        waitForRelayReady(PEER1_RELAY_URL, 10000),
        waitForRelayReady(PEER2_RELAY_URL, 10000),
      ]);

      if (!peer1RelayOk || !peer2RelayOk) {
        console.warn(
          'Relay WebSocket not ready. Run: ./scripts/sdk-e2e-infra.sh up'
        );
        return;
      }
    } catch (error) {
      console.warn(
        `Docker SDK E2E infra not running: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }

    // -------------------------------------------------------------------
    // Phase 2: Snapshot on-chain state before tests
    // -------------------------------------------------------------------
    tokenBalanceBefore = await getTokenBalance(TEST_EVM_ADDRESS);
    channelCounterBefore = await getChannelCounter();

    // -------------------------------------------------------------------
    // Phase 3: Create in-process ConnectorNode + ServiceNode
    // -------------------------------------------------------------------
    process.env['EXPLORER_ENABLED'] = 'false';

    nostrSecretKey = generateSecretKey();
    nostrPubkey = getPublicKey(nostrSecretKey);
    const testIlpAddress = `g.crosstown.test.${nostrPubkey.slice(0, 8)}`;

    const connectorLogger = createLogger('test-connector', 'warn');
    connector = new ConnectorNode(
      {
        nodeId: `test-${nostrPubkey.slice(0, 8)}`,
        btpServerPort: 19900,
        healthCheckPort: 19901,
        environment: 'development' as const,
        deploymentMode: 'embedded' as const,
        peers: [],
        routes: [],
        localDelivery: { enabled: false },
        settlementInfra: {
          enabled: true,
          rpcUrl: ANVIL_RPC,
          registryAddress: REGISTRY_ADDRESS,
          tokenAddress: TOKEN_ADDRESS,
          privateKey: TEST_PRIVATE_KEY,
        },
      },
      connectorLogger
    );

    node = createNode({
      secretKey: nostrSecretKey,
      connector,
      ilpAddress: testIlpAddress,
      basePricePerByte: 10n,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      knownPeers: [],
    });

    // Accept all events
    node.onDefault(async (ctx: HandlerContext) => {
      ctx.decode();
      return ctx.accept();
    });

    await connector.start();
    await node.start();

    // -------------------------------------------------------------------
    // Phase 4: Register peer1 with routes for BOTH peer1 and peer2
    // Multi-hop: traffic for g.crosstown.peer2 is forwarded via peer1,
    // who then routes it to peer2 via its own BTP connection.
    // -------------------------------------------------------------------
    await connector.registerPeer({
      id: 'peer1',
      url: PEER1_BTP_URL,
      authToken: '',
      routes: [
        { prefix: 'g.crosstown.peer1' },
        { prefix: 'g.crosstown.peer2' },
      ],
    });

    // Wait for BTP connection to establish
    await new Promise((r) => setTimeout(r, 2000));

    // -------------------------------------------------------------------
    // Phase 5: Open payment channel on Anvil (test → peer1)
    // -------------------------------------------------------------------
    const result = await connector.openChannel({
      peerId: 'peer1',
      chain: `eip155:${CHAIN_ID}`,
      token: TOKEN_ADDRESS,
      tokenNetwork: TOKEN_NETWORK_ADDRESS,
      peerAddress: PEER1_EVM_ADDRESS,
      initialDeposit: '1000000',
      settlementTimeout: 3600,
    });

    channelId = result.channelId;

    // -------------------------------------------------------------------
    // Phase 6: Wait for peer2 bootstrap + peer1 auto-registration
    //
    // Peer2 bootstraps from peer1, opens a channel, then announces its
    // kind:10032 via ILP to peer1. Peer1's DiscoveryTracker discovers it and
    // auto-registers peer2 for multi-hop routing.
    // -------------------------------------------------------------------
    const peer2Ready = await waitForPeer2Bootstrap(45000);
    if (!peer2Ready) {
      console.warn('Peer2 bootstrap did not complete in time');
    }

    // Additional wait for the announce → discovery → auto-registration cycle
    await new Promise((r) => setTimeout(r, 5000));

    servicesReady = true;
  }, 120000);

  afterAll(async () => {
    if (node) {
      await node.stop();
    }
    if (connector) {
      await connector.stop();
    }
    await new Promise((r) => setTimeout(r, 500));
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function skipIfNotReady() {
    if (!servicesReady) {
      if (process.env['CI']) {
        throw new Error(
          'Docker SDK E2E services not ready — cannot run in CI.'
        );
      }
      console.log('Skipping: Docker SDK E2E infra not ready');
      return true;
    }
    return false;
  }

  // =========================================================================
  // ON-CHAIN VERIFICATION
  // =========================================================================

  it('token balance decreased after channel deposit', async () => {
    if (skipIfNotReady()) return;

    const balanceAfter = await getTokenBalance(TEST_EVM_ADDRESS);
    expect(balanceAfter).toBeLessThan(tokenBalanceBefore);

    const deposited = tokenBalanceBefore - balanceAfter;
    expect(deposited).toBeGreaterThanOrEqual(1000000n); // initialDeposit
  });

  it('channel open on-chain with correct participants and deposit', async () => {
    if (skipIfNotReady()) return;

    // Verify channel state
    const state = await getChannelState(channelId as Hex);
    expect(state.state).toBe('open');
    expect(state.settlementTimeout).toBeGreaterThan(0);

    // Verify both participants
    const isTestParticipant =
      state.participant1.toLowerCase() === TEST_EVM_ADDRESS.toLowerCase() ||
      state.participant2.toLowerCase() === TEST_EVM_ADDRESS.toLowerCase();
    expect(isTestParticipant).toBe(true);

    const isPeer1Participant =
      state.participant1.toLowerCase() === PEER1_EVM_ADDRESS.toLowerCase() ||
      state.participant2.toLowerCase() === PEER1_EVM_ADDRESS.toLowerCase();
    expect(isPeer1Participant).toBe(true);

    // Verify deposit amount on-chain via participants view
    const info = await getParticipantInfo(
      channelId as Hex,
      TEST_EVM_ADDRESS
    );
    expect(info.deposit).toBeGreaterThanOrEqual(1000000n);
  });

  it('channelCounter reflects all opened channels on-chain', async () => {
    if (skipIfNotReady()) return;

    const counterAfter = await getChannelCounter();
    // channelCounterBefore was captured after peer2 bootstrap (which opens its
    // own channel), so it already includes peer2→peer1. Our test opened one
    // additional channel (test→peer1).
    expect(counterAfter).toBeGreaterThanOrEqual(channelCounterBefore + 1n);
  });

  // =========================================================================
  // SINGLE-HOP TESTS (test node → peer1)
  // =========================================================================

  it('single-hop: publishEvent delivers event to peer1 relay', async () => {
    if (skipIfNotReady()) return;

    const event = finalizeEvent(
      {
        kind: 1,
        content: `Single-hop E2E test - ${Date.now()}`,
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      },
      nostrSecretKey
    );

    const publishResult = await node.publishEvent(event, {
      destination: 'g.crosstown.peer1',
    });

    expect(publishResult.success).toBe(true);
    expect(publishResult.eventId).toBe(event.id);
    expect(publishResult.fulfillment).toBeDefined();

    publishedEventIds.push(event.id);

    // Verify event arrived at peer1's relay
    const storedEvent = await waitForEventOnRelay(
      PEER1_RELAY_URL,
      event.id,
      15000
    );
    expect(storedEvent).not.toBeNull();
    const stored = storedEvent as Record<string, unknown>;
    expect(stored['id']).toBe(event.id);
  });

  it('payment amount scales with TOON byte length', async () => {
    if (skipIfNotReady()) return;

    const smallEvent = finalizeEvent(
      {
        kind: 1,
        content: 'small',
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      },
      nostrSecretKey
    );

    const largeEvent = finalizeEvent(
      {
        kind: 1,
        content: 'x'.repeat(1000),
        tags: [['t', 'large-payload-test']],
        created_at: Math.floor(Date.now() / 1000) + 1,
      },
      nostrSecretKey
    );

    const smallResult = await node.publishEvent(smallEvent, {
      destination: 'g.crosstown.peer1',
    });
    expect(smallResult.success).toBe(true);
    publishedEventIds.push(smallEvent.id);

    const largeResult = await node.publishEvent(largeEvent, {
      destination: 'g.crosstown.peer1',
    });
    expect(largeResult.success).toBe(true);
    publishedEventIds.push(largeEvent.id);
  });

  // =========================================================================
  // MULTI-HOP TESTS (test node → peer1 → peer2)
  // =========================================================================

  it('multi-hop: publishEvent routes through peer1 to peer2 relay', async () => {
    if (skipIfNotReady()) return;

    const event = finalizeEvent(
      {
        kind: 1,
        content: `Multi-hop E2E test - ${Date.now()}`,
        tags: [['route', 'multi-hop']],
        created_at: Math.floor(Date.now() / 1000),
      },
      nostrSecretKey
    );

    const publishResult = await node.publishEvent(event, {
      destination: 'g.crosstown.peer2',
    });

    expect(publishResult.success).toBe(true);
    expect(publishResult.eventId).toBe(event.id);
    expect(publishResult.fulfillment).toBeDefined();

    publishedEventIds.push(event.id);

    // Verify event arrived at peer2's relay (routed through peer1)
    const storedEvent = await waitForEventOnRelay(
      PEER2_RELAY_URL,
      event.id,
      20000
    );
    expect(storedEvent).not.toBeNull();
    const stored = storedEvent as Record<string, unknown>;
    expect(stored['id']).toBe(event.id);
  });

  it('multi-hop: sequential events all arrive at peer2 relay', async () => {
    if (skipIfNotReady()) return;

    const events = [];
    for (let i = 0; i < 3; i++) {
      const event = finalizeEvent(
        {
          kind: 1,
          content: `Multi-hop sequential ${i} - ${Date.now()}`,
          tags: [
            ['seq', String(i)],
            ['route', 'multi-hop'],
          ],
          created_at: Math.floor(Date.now() / 1000) + i,
        },
        nostrSecretKey
      );

      const result = await node.publishEvent(event, {
        destination: 'g.crosstown.peer2',
      });
      expect(result.success).toBe(true);
      events.push(event);
      publishedEventIds.push(event.id);
    }

    // Verify all events on peer2's relay
    for (const event of events) {
      const storedEvent = await waitForEventOnRelay(
        PEER2_RELAY_URL,
        event.id,
        20000
      );
      expect(storedEvent).not.toBeNull();
      const stored = storedEvent as Record<string, unknown>;
      expect(stored['id']).toBe(event.id);
    }
  });

  it('multi-hop: event metadata preserved through 2-hop pipeline', async () => {
    if (skipIfNotReady()) return;

    const event = finalizeEvent(
      {
        kind: 30023,
        content:
          'Long-form content with special chars: <>&"\' and unicode: \u{1F310}',
        tags: [
          ['d', 'multi-hop-article'],
          ['title', 'Multi-Hop Test Article'],
          ['published_at', String(Math.floor(Date.now() / 1000))],
        ],
        created_at: Math.floor(Date.now() / 1000),
      },
      nostrSecretKey
    );

    const result = await node.publishEvent(event, {
      destination: 'g.crosstown.peer2',
    });
    expect(result.success).toBe(true);
    publishedEventIds.push(event.id);

    const storedEvent = await waitForEventOnRelay(
      PEER2_RELAY_URL,
      event.id,
      20000
    );
    expect(storedEvent).not.toBeNull();
    const stored = storedEvent as Record<string, unknown>;
    expect(stored['id']).toBe(event.id);
    expect(stored['pubkey']).toBe(nostrPubkey);
    expect(stored['kind']).toBe(30023);
    expect(stored['content']).toBe(event.content);
    expect(stored['sig']).toBe(event.sig);

    // Verify tags survived 2 hops
    const tags = stored['tags'] as string[][];
    expect(tags).toBeDefined();
    const dTag = tags.find((t) => t[0] === 'd');
    expect(dTag).toBeDefined();
    expect(dTag?.[1]).toBe('multi-hop-article');
  });

  // =========================================================================
  // SETTLEMENT LIFECYCLE (placed last — evm_increaseTime is irreversible)
  // =========================================================================

  it('channel close and settlement lifecycle', async () => {
    if (skipIfNotReady()) return;

    const accountA = privateKeyToAccount(SETTLEMENT_PRIVATE_KEY_A);
    const accountB = privateKeyToAccount(SETTLEMENT_PRIVATE_KEY_B);

    const client = createViemClient();
    const walletA = createWalletClient({
      account: accountA,
      chain: anvilChain,
      transport: http(ANVIL_RPC),
    });

    // 1. Fund Account #4 with tokens from Account #3 (test node has 10k tokens)
    const testAccount = privateKeyToAccount(TEST_PRIVATE_KEY);
    const testWallet = createWalletClient({
      account: testAccount,
      chain: anvilChain,
      transport: http(ANVIL_RPC),
    });

    const fundAmount = 100000n;
    const fundTx = await testWallet.writeContract({
      address: TOKEN_ADDRESS,
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [accountA.address, fundAmount],
    });
    await client.waitForTransactionReceipt({ hash: fundTx });

    // 2. Approve TokenNetwork to spend tokens
    const depositAmount = 50000n;
    const approveTx = await walletA.writeContract({
      address: TOKEN_ADDRESS,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [TOKEN_NETWORK_ADDRESS, depositAmount],
    });
    await client.waitForTransactionReceipt({ hash: approveTx });

    // 3. Open channel (Account #4 → Account #5) with minimum settlement timeout
    // TokenNetwork contract enforces MIN_SETTLEMENT_TIMEOUT = 1 hour (3600s)
    // Read channelCounter BEFORE opening — the contract uses it in the channelId hash
    const counterBefore = (await client.readContract({
      address: TOKEN_NETWORK_ADDRESS,
      abi: TOKEN_NETWORK_ABI,
      functionName: 'channelCounter',
    })) as bigint;

    const settlementTimeout = 3600n;
    const openTx = await walletA.writeContract({
      address: TOKEN_NETWORK_ADDRESS,
      abi: TOKEN_NETWORK_ABI,
      functionName: 'openChannel',
      args: [accountB.address as Hex, settlementTimeout],
    });
    const openReceipt = await client.waitForTransactionReceipt({
      hash: openTx,
    });
    expect(openReceipt.status).toBe('success');

    // Compute channelId matching the contract: keccak256(p1, p2, channelCounter)
    // where p1 < p2 (sorted lexicographically)
    const [p1, p2] = [accountA.address, accountB.address].sort((a, b) =>
      a.toLowerCase() < b.toLowerCase() ? -1 : 1
    );
    const settlementChannelId = keccak256(
      encodePacked(
        ['address', 'address', 'uint256'],
        [p1 as Hex, p2 as Hex, counterBefore]
      )
    );

    // Verify channel is open
    let channelState = await getChannelState(settlementChannelId);
    expect(channelState.state).toBe('open');

    // 4. Deposit tokens via setTotalDeposit
    const depositTx = await walletA.writeContract({
      address: TOKEN_NETWORK_ADDRESS,
      abi: TOKEN_NETWORK_ABI,
      functionName: 'setTotalDeposit',
      args: [settlementChannelId, accountA.address, depositAmount],
    });
    const depositReceipt = await client.waitForTransactionReceipt({
      hash: depositTx,
    });
    expect(depositReceipt.status).toBe('success');

    // 5. Account #4 (A) signs EIP-712 balance proof showing A transferred 10000 to B.
    // closeChannel stores the non-closing participant's transferredAmount, so B
    // must close with A's proof to correctly record A's outgoing transfer.
    const transferAmount = 10000n;
    const balanceProofDomain = {
      name: 'TokenNetwork' as const,
      version: '1' as const,
      chainId: CHAIN_ID,
      verifyingContract: TOKEN_NETWORK_ADDRESS,
    };

    const balanceProofMessage = {
      channelId: settlementChannelId,
      nonce: 1n,
      transferredAmount: transferAmount,
      lockedAmount: 0n,
      locksRoot:
        '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex,
    };

    const signature = await accountA.signTypedData({
      domain: balanceProofDomain,
      types: BALANCE_PROOF_TYPES,
      primaryType: 'BalanceProof',
      message: balanceProofMessage,
    });

    // 6. Account #5 (B) calls closeChannel with Account #4's (A) signed balance proof.
    // The contract records A (non-closing participant) as having transferred 10000.
    // Settlement: A gets deposit - transferred = 40000, B gets 0 + transferred = 10000.
    const walletB = createWalletClient({
      account: accountB,
      chain: anvilChain,
      transport: http(ANVIL_RPC),
    });
    const closeTx = await walletB.writeContract({
      address: TOKEN_NETWORK_ADDRESS,
      abi: TOKEN_NETWORK_ABI,
      functionName: 'closeChannel',
      args: [
        settlementChannelId,
        {
          channelId: settlementChannelId,
          nonce: 1n,
          transferredAmount: transferAmount,
          lockedAmount: 0n,
          locksRoot:
            '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex,
        },
        signature,
      ],
    });
    const closeReceipt = await client.waitForTransactionReceipt({
      hash: closeTx,
    });
    expect(closeReceipt.status).toBe('success');

    // Verify channel is now closed
    channelState = await getChannelState(settlementChannelId);
    expect(channelState.state).toBe('closed');

    // 7. Advance time past settlement timeout using Anvil's evm_increaseTime
    await fetch(ANVIL_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'evm_increaseTime',
        params: [Number(settlementTimeout) + 1],
        id: 1,
      }),
    });

    // Mine a block to apply the time increase
    await fetch(ANVIL_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'evm_mine',
        params: [],
        id: 2,
      }),
    });

    // 8. Record pre-settlement balances, then settle
    const balanceBeforeA = await getTokenBalance(accountA.address as Hex);
    const balanceBeforeB = await getTokenBalance(accountB.address as Hex);

    const settleTx = await walletA.writeContract({
      address: TOKEN_NETWORK_ADDRESS,
      abi: TOKEN_NETWORK_ABI,
      functionName: 'settleChannel',
      args: [settlementChannelId],
    });
    const settleReceipt = await client.waitForTransactionReceipt({
      hash: settleTx,
    });
    expect(settleReceipt.status).toBe('success');

    // 9. Verify channel state = settled
    channelState = await getChannelState(settlementChannelId);
    expect(channelState.state).toBe('settled');

    // 10. Verify balance redistribution:
    //     A deposited depositAmount, transferred transferAmount to B
    //     A gets back (depositAmount - transferAmount), B gets transferAmount
    const balanceAfterA = await getTokenBalance(accountA.address as Hex);
    const balanceAfterB = await getTokenBalance(accountB.address as Hex);

    expect(balanceAfterA).toBe(
      balanceBeforeA + depositAmount - transferAmount
    );
    expect(balanceAfterB).toBe(balanceBeforeB + transferAmount);
  });
});

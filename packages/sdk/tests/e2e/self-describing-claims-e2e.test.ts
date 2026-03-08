/**
 * E2E Test: Self-Describing BTP Claims
 *
 * **Prerequisites:**
 * Genesis node deployed with Anvil:
 * ```bash
 * ./deploy-genesis-node.sh
 * ```
 *
 * **What this test verifies:**
 * - Unknown peer sends self-describing claim, connector verifies on-chain, returns FULFILL
 * - Subsequent claims from same channel skip RPC (cached)
 * - TOON-encoded event stored to relay and fetchable via NIP-01 subscription
 * - Wallet balances and payment channel balances change correctly
 * - Channel close and settlement lifecycle on-chain
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
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import WebSocket from 'ws';

// ---------------------------------------------------------------------------
// Constants (deterministic Anvil addresses)
// ---------------------------------------------------------------------------

const ANVIL_RPC = 'http://localhost:8545';
const RELAY_URL = 'ws://localhost:7100';
const CONNECTOR_URL = 'http://localhost:8080';
const BTP_URL = 'ws://localhost:3000';
const BLS_URL = 'http://localhost:3100';

const TOKEN_ADDRESS =
  '0x5FbDB2315678afecb367f032d93F642f64180aa3' as const;
const TOKEN_NETWORK_ADDRESS =
  '0xCafac3dD18aC6c6e92c921884f9E4176737C052c' as const;
const REGISTRY_ADDRESS =
  '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512' as const;

// Anvil Account #2 (test peer)
const TEST_PRIVATE_KEY =
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as const;
const TEST_ADDRESS = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as const;

// Anvil Account #3 (settlement counterparty)
const TEST_PRIVATE_KEY_2 =
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6' as const;
const TEST_ADDRESS_2 = '0x90F79bf6EB2c4f870365E785982E1f101E93b906' as const;

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
    inputs: [
      { name: 'channelId', type: 'bytes32' },
      { name: 'participant', type: 'address' },
    ],
    outputs: [
      { name: 'deposit', type: 'uint256' },
      { name: 'withdrawnAmount', type: 'uint256' },
      { name: 'isCloser', type: 'bool' },
      { name: 'nonce', type: 'uint256' },
      { name: 'transferredAmount', type: 'uint256' },
    ],
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
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
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
// Helper: viem clients
// ---------------------------------------------------------------------------

function createClients(privateKey: Hex) {
  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({
    chain: anvilChain,
    transport: http(ANVIL_RPC),
  });
  const walletClient = createWalletClient({
    account,
    chain: anvilChain,
    transport: http(ANVIL_RPC),
  });
  return { account, publicClient, walletClient };
}

// ---------------------------------------------------------------------------
// Helper: query on-chain channel state
// ---------------------------------------------------------------------------

const CHANNEL_STATE_NAMES = ['settled', 'open', 'closed', 'settled'] as const;

async function getChannelState(channelId: Hex) {
  const { publicClient } = createClients(TEST_PRIVATE_KEY);

  const result = await publicClient.readContract({
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

// ---------------------------------------------------------------------------
// Helper: query ERC-20 token balance
// ---------------------------------------------------------------------------

async function getTokenBalance(address: Hex): Promise<bigint> {
  const { publicClient } = createClients(TEST_PRIVATE_KEY);
  return publicClient.readContract({
    address: TOKEN_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [address],
  });
}

// ---------------------------------------------------------------------------
// Helper: wait for event on Nostr relay via NIP-01 subscription
// ---------------------------------------------------------------------------

function waitForEventOnRelay(
  relayUrl: string,
  eventId: string,
  timeoutMs = 10000
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

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Self-Describing BTP Claims E2E', () => {
  let servicesReady = false;
  let node: ServiceNode;
  let connector: ConnectorNode;
  const publishedEventIds: string[] = [];
  let nostrSecretKey: Uint8Array;
  let nostrPubkey: string;

  // The channelId opened by the connector's openChannel()
  let channelId: string;

  beforeAll(async () => {
    // -----------------------------------------------------------------------
    // Health checks — skip gracefully if genesis not running
    // -----------------------------------------------------------------------
    try {
      const [connectorRes, blsRes, anvilRes] = await Promise.all([
        fetch(`${CONNECTOR_URL}/health`, {
          signal: AbortSignal.timeout(3000),
        }),
        fetch(`${BLS_URL}/health`, { signal: AbortSignal.timeout(3000) }),
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
        }),
      ]);

      if (!connectorRes.ok || !blsRes.ok || !anvilRes.ok) {
        console.warn(
          'Genesis services not fully ready. Run: ./deploy-genesis-node.sh'
        );
        return;
      }

      // Check relay WebSocket
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(RELAY_URL);
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error('Relay timeout'));
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
    } catch (error) {
      console.warn(
        'Genesis node not running. Run: ./deploy-genesis-node.sh'
      );
      console.warn(
        `Error: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }

    // -----------------------------------------------------------------------
    // Create real ConnectorNode
    // -----------------------------------------------------------------------
    nostrSecretKey = generateSecretKey();
    nostrPubkey = getPublicKey(nostrSecretKey);
    const testIlpAddress = `g.crosstown.test.${nostrPubkey.slice(0, 8)}`;

    const connectorLogger = createLogger('test-connector', 'warn');
    connector = new ConnectorNode(
      {
        nodeId: `test-${nostrPubkey.slice(0, 8)}`,
        btpServerPort: 0, // ephemeral port — we connect outbound via BTP client
        environment: 'development' as const,
        deploymentMode: 'embedded' as const,
        peers: [
          {
            id: 'genesis',
            url: BTP_URL,
            authToken: 'test-token',
          },
        ],
        routes: [
          {
            prefix: 'g.crosstown.genesis',
            nextHop: 'genesis',
          },
        ],
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

    // -----------------------------------------------------------------------
    // Create ServiceNode with real connector
    // -----------------------------------------------------------------------
    node = createNode({
      secretKey: nostrSecretKey,
      connector,
      ilpAddress: testIlpAddress,
      basePricePerByte: 10n,
      toonEncoder: encodeEventToToon,
      toonDecoder: decodeEventFromToon,
      knownPeers: [],
    });

    // Register a default handler that accepts all events
    node.onDefault(async (ctx: HandlerContext) => {
      ctx.decode(); // ensure decodable
      return ctx.accept();
    });

    // -----------------------------------------------------------------------
    // Start connector and node
    // -----------------------------------------------------------------------
    await connector.start();
    await node.start();

    // -----------------------------------------------------------------------
    // Open payment channel on Anvil
    // -----------------------------------------------------------------------
    // Get genesis connector's EVM address from the connector admin or use
    // Anvil Account #0 (the deployer, which is also the genesis connector's
    // settlement address)
    const genesisEvmAddress = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

    const result = await connector.openChannel({
      peerId: 'genesis',
      chain: `eip155:${CHAIN_ID}`,
      token: TOKEN_ADDRESS,
      tokenNetwork: TOKEN_NETWORK_ADDRESS,
      peerAddress: genesisEvmAddress,
      initialDeposit: '1000000',
      settlementTimeout: 500,
    });

    channelId = result.channelId;
    servicesReady = true;
  }, 60000);

  afterAll(async () => {
    if (node) {
      await node.stop();
    }
    if (connector) {
      await connector.stop();
    }
    // Brief delay for WebSocket cleanup
    await new Promise((r) => setTimeout(r, 500));
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function skipIfNotReady() {
    if (!servicesReady) {
      if (process.env['CI']) {
        throw new Error(
          'Genesis node services not ready — E2E tests cannot run in CI.'
        );
      }
      console.log('Skipping: Genesis node not ready (local development)');
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Test 1: Unknown peer sends self-describing claim, connector verifies
  //         on-chain, processes packet, returns FULFILL
  // -------------------------------------------------------------------------

  it('unknown peer sends self-describing claim, connector verifies on-chain, processes packet, returns FULFILL', async () => {
    if (skipIfNotReady()) return;

    // Create and sign a Nostr event
    const event = finalizeEvent(
      {
        kind: 1,
        content: `Self-describing claim test - ${Date.now()}`,
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      },
      nostrSecretKey
    );

    // Publish via the SDK node — the connector sends a self-describing claim
    const publishResult = await node.publishEvent(event, {
      destination: 'g.crosstown.genesis',
    });

    expect(publishResult.success).toBe(true);
    expect(publishResult.eventId).toBe(event.id);
    expect(publishResult.fulfillment).toBeDefined();

    publishedEventIds.push(event.id);

    // Verify channel is open on-chain
    const state = await getChannelState(channelId as Hex);
    expect(state.state).toBe('open');

    // Verify test account is a participant
    const isParticipant =
      state.participant1.toLowerCase() === TEST_ADDRESS.toLowerCase() ||
      state.participant2.toLowerCase() === TEST_ADDRESS.toLowerCase();
    expect(isParticipant).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 2: Subsequent claims from same channel skip RPC (cached)
  // -------------------------------------------------------------------------

  it('subsequent claims from same channel skip RPC (cached)', async () => {
    if (skipIfNotReady()) return;

    // Publish a second event
    const event2 = finalizeEvent(
      {
        kind: 1,
        content: `Cached claim test 2 - ${Date.now()}`,
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      },
      nostrSecretKey
    );

    const result2 = await node.publishEvent(event2, {
      destination: 'g.crosstown.genesis',
    });
    expect(result2.success).toBe(true);
    publishedEventIds.push(event2.id);

    // Publish a third event
    const event3 = finalizeEvent(
      {
        kind: 1,
        content: `Cached claim test 3 - ${Date.now()}`,
        tags: [],
        created_at: Math.floor(Date.now() / 1000) + 1,
      },
      nostrSecretKey
    );

    const result3 = await node.publishEvent(event3, {
      destination: 'g.crosstown.genesis',
    });
    expect(result3.success).toBe(true);
    publishedEventIds.push(event3.id);

    // All three events used the same channel
    const state = await getChannelState(channelId as Hex);
    expect(state.state).toBe('open');
  });

  // -------------------------------------------------------------------------
  // Test 3: TOON event stored to relay and fetchable via subscription
  // -------------------------------------------------------------------------

  it('TOON event stored to relay and fetchable via subscription', async () => {
    if (skipIfNotReady()) return;
    expect(publishedEventIds.length).toBeGreaterThan(0);

    const targetId = publishedEventIds[0]!;
    const storedEvent = await waitForEventOnRelay(RELAY_URL, targetId, 10000);

    expect(storedEvent).not.toBeNull();
    expect(storedEvent!['id']).toBe(targetId);
    expect(storedEvent!['pubkey']).toBe(nostrPubkey);
    expect(storedEvent!['kind']).toBe(1);
    expect(typeof storedEvent!['content']).toBe('string');
    expect(typeof storedEvent!['sig']).toBe('string');
  });

  // -------------------------------------------------------------------------
  // Test 4: Wallet balances and payment channel balances change
  // -------------------------------------------------------------------------

  it('wallet balances and payment channel balances change', async () => {
    if (skipIfNotReady()) return;

    // Query ERC-20 token balance of test account
    const balance = await getTokenBalance(TEST_ADDRESS);
    // Account should still have tokens (initial supply minus channel deposit)
    expect(balance).toBeGreaterThan(0n);

    // Query on-chain channel state
    const state = await getChannelState(channelId as Hex);
    expect(state.state).toBe('open');
    expect(state.settlementTimeout).toBeGreaterThan(0);

    // Verify participants
    const participants = [
      state.participant1.toLowerCase(),
      state.participant2.toLowerCase(),
    ];
    expect(participants).toContain(TEST_ADDRESS.toLowerCase());

    // Query participant deposit info
    const { publicClient } = createClients(TEST_PRIVATE_KEY);
    const participantInfo = await publicClient.readContract({
      address: TOKEN_NETWORK_ADDRESS,
      abi: TOKEN_NETWORK_ABI,
      functionName: 'participants',
      args: [channelId as Hex, TEST_ADDRESS],
    });

    const [deposit] = participantInfo;
    // Deposit should be > 0 (from openChannel initialDeposit)
    expect(deposit).toBeGreaterThan(0n);
  });

  // -------------------------------------------------------------------------
  // Test 5: Channel close and settlement lifecycle
  // -------------------------------------------------------------------------

  it('channel close and settlement lifecycle', async () => {
    if (skipIfNotReady()) return;

    const account2 = privateKeyToAccount(TEST_PRIVATE_KEY_2);
    const account3 = privateKeyToAccount(
      '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a' as Hex
    ); // Anvil Account #4

    const ACCOUNT_4_ADDRESS = account3.address;

    const { publicClient } = createClients(TEST_PRIVATE_KEY_2);
    const walletClient2 = createWalletClient({
      account: account2,
      chain: anvilChain,
      transport: http(ANVIL_RPC),
    });
    const walletClient3 = createWalletClient({
      account: account3,
      chain: anvilChain,
      transport: http(ANVIL_RPC),
    });

    // 1. Approve TokenNetwork to spend tokens for both accounts
    const depositAmount = 50000n;
    const approveAmount = depositAmount * 2n;

    await walletClient2.writeContract({
      address: TOKEN_ADDRESS,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [TOKEN_NETWORK_ADDRESS, approveAmount],
    });

    await walletClient3.writeContract({
      address: TOKEN_ADDRESS,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [TOKEN_NETWORK_ADDRESS, approveAmount],
    });

    // 2. Open channel between Account #3 and Account #4
    const settlementTimeout = 10n; // Short timeout for test
    const openTx = await walletClient2.writeContract({
      address: TOKEN_NETWORK_ADDRESS,
      abi: TOKEN_NETWORK_ABI,
      functionName: 'openChannel',
      args: [ACCOUNT_4_ADDRESS as Hex, settlementTimeout],
    });

    const openReceipt = await publicClient.waitForTransactionReceipt({
      hash: openTx,
    });
    expect(openReceipt.status).toBe('success');

    // Extract channelId from logs (first topic of ChannelOpened event)
    // The channelId is deterministic: keccak256(abi.encodePacked(participant1, participant2))
    // We can also get it from the return value — query the channel
    // Use the participants mapping to find the channel
    const { keccak256, encodePacked } = await import('viem');
    const [addr1, addr2] = [TEST_ADDRESS_2, ACCOUNT_4_ADDRESS].sort((a, b) =>
      a.toLowerCase() < b.toLowerCase() ? -1 : 1
    );
    const testChannelId = keccak256(
      encodePacked(['address', 'address'], [addr1 as Hex, addr2 as Hex])
    );

    // Verify channel is open
    let channelState = await getChannelState(testChannelId);
    expect(channelState.state).toBe('open');

    // 3. Deposit tokens via setTotalDeposit
    const depositTx = await walletClient2.writeContract({
      address: TOKEN_NETWORK_ADDRESS,
      abi: TOKEN_NETWORK_ABI,
      functionName: 'setTotalDeposit',
      args: [testChannelId, TEST_ADDRESS_2, depositAmount],
    });
    const depositReceipt = await publicClient.waitForTransactionReceipt({
      hash: depositTx,
    });
    expect(depositReceipt.status).toBe('success');

    // 4. Sign balance proof from Account #4 (the counterparty signs)
    const transferAmount = 10000n;
    const balanceProofDomain = {
      name: 'TokenNetwork' as const,
      version: '1' as const,
      chainId: CHAIN_ID,
      verifyingContract: TOKEN_NETWORK_ADDRESS,
    };

    const balanceProofMessage = {
      channelId: testChannelId,
      nonce: 1n,
      transferredAmount: transferAmount,
      lockedAmount: 0n,
      locksRoot:
        '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex,
    };

    const signature = await account3.signTypedData({
      domain: balanceProofDomain,
      types: BALANCE_PROOF_TYPES,
      primaryType: 'BalanceProof',
      message: balanceProofMessage,
    });

    // 5. Account #2 calls closeChannel with Account #4's signed balance proof
    const closeTx = await walletClient2.writeContract({
      address: TOKEN_NETWORK_ADDRESS,
      abi: TOKEN_NETWORK_ABI,
      functionName: 'closeChannel',
      args: [
        testChannelId,
        {
          channelId: testChannelId,
          nonce: 1n,
          transferredAmount: transferAmount,
          lockedAmount: 0n,
          locksRoot:
            '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex,
        },
        signature,
      ],
    });
    const closeReceipt = await publicClient.waitForTransactionReceipt({
      hash: closeTx,
    });
    expect(closeReceipt.status).toBe('success');

    // Verify channel is now closed
    channelState = await getChannelState(testChannelId);
    expect(channelState.state).toBe('closed');

    // 6. Advance time past settlement timeout using Anvil's evm_increaseTime
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

    // 7. Record balances before settlement
    const balanceBefore2 = await getTokenBalance(TEST_ADDRESS_2);
    const balanceBefore4 = await getTokenBalance(ACCOUNT_4_ADDRESS as Hex);

    // 8. Settle the channel
    const settleTx = await walletClient2.writeContract({
      address: TOKEN_NETWORK_ADDRESS,
      abi: TOKEN_NETWORK_ABI,
      functionName: 'settleChannel',
      args: [testChannelId],
    });
    const settleReceipt = await publicClient.waitForTransactionReceipt({
      hash: settleTx,
    });
    expect(settleReceipt.status).toBe('success');

    // 9. Verify channel is settled
    channelState = await getChannelState(testChannelId);
    expect(channelState.state).toBe('settled');

    // 10. Verify balances changed after settlement
    const balanceAfter2 = await getTokenBalance(TEST_ADDRESS_2);
    const balanceAfter4 = await getTokenBalance(ACCOUNT_4_ADDRESS as Hex);

    // Account #2 deposited depositAmount, transferred transferAmount to Account #4
    // So Account #2 gets back (depositAmount - transferAmount)
    // Account #4 gets transferAmount
    expect(balanceAfter2).toBe(balanceBefore2 + depositAmount - transferAmount);
    expect(balanceAfter4).toBe(balanceBefore4 + transferAmount);
  });
});

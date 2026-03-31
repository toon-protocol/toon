/**
 * Shared Docker E2E test infrastructure.
 *
 * Constants, ABIs, chain definitions, and helper functions used across
 * all Docker-based E2E tests. Extracted from docker-publish-event-e2e.test.ts
 * to avoid duplication.
 *
 * Prerequisites: SDK E2E infrastructure running via `./scripts/sdk-e2e-infra.sh up`
 */

import {
  createPublicClient,
  http,
  defineChain,
  type Hex,
} from 'viem';
import WebSocket from 'ws';
import { decodeEventFromToon } from '@toon-protocol/relay';

// ---------------------------------------------------------------------------
// Constants (Docker SDK E2E ports — see docker-compose-sdk-e2e.yml)
// ---------------------------------------------------------------------------

export const ANVIL_RPC = 'http://localhost:18545';

// Peer 1 (Docker — genesis-like)
export const PEER1_RELAY_URL = 'ws://localhost:19700';
export const PEER1_BTP_URL = 'ws://localhost:19000';
export const PEER1_BLS_URL = 'http://localhost:19100';
export const PEER1_EVM_ADDRESS =
  '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const; // Anvil Account #0

// Peer 2 (Docker — bootstraps from peer1)
export const PEER2_RELAY_URL = 'ws://localhost:19710';
export const PEER2_BLS_URL = 'http://localhost:19110';

// Contracts (deterministic Anvil deployment)
export const TOKEN_ADDRESS =
  '0x5FbDB2315678afecb367f032d93F642f64180aa3' as const; // Mock USDC (Anvil)
export const TOKEN_NETWORK_ADDRESS =
  '0xCafac3dD18aC6c6e92c921884f9E4176737C052c' as const;
export const REGISTRY_ADDRESS =
  '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512' as const;

// Per-test-file Anvil accounts to avoid nonce contention.
// Docker infra uses: Account #0 (peer1), Account #2 (peer2).
// Each test file gets its own account so concurrent tests don't conflict.

// Account #3 — docker-publish-event-e2e
export const TEST_PRIVATE_KEY =
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6' as const;
export const TEST_EVM_ADDRESS =
  '0x90F79bf6EB2c4f870365E785982E1f101E93b906' as const;

// Account #4 — settlement tests within docker-publish-event-e2e
export const SETTLEMENT_PRIVATE_KEY_A =
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a' as const;
// Account #5 — settlement tests within docker-publish-event-e2e
export const SETTLEMENT_PRIVATE_KEY_B =
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba' as const;

// Account #6 — docker-workflow-chain-e2e
export const WORKFLOW_PRIVATE_KEY =
  '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e' as const;
// Account #7 — docker-dvm-lifecycle-e2e
export const DVM_LIFECYCLE_PRIVATE_KEY =
  '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356' as const;
// Account #8 — docker-dvm-submission-e2e
export const DVM_SUBMISSION_PRIVATE_KEY =
  '0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97' as const;
// Account #9 — docker-swarm-e2e
export const SWARM_PRIVATE_KEY =
  '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6' as const;

export const CHAIN_ID = 31337;

// Multi-chain constants
export const SOLANA_RPC = 'http://localhost:19899';
export const SOLANA_WS = 'ws://localhost:19900';
export const SOLANA_PROGRAM_ID = process.env['SOLANA_PROGRAM_ID'] || '';
export const MINA_GRAPHQL = 'http://localhost:19085/graphql';
export const MINA_ACCOUNTS_MANAGER = 'http://localhost:19181';
export const MINA_ZKAPP_ADDRESS = process.env['MINA_ZKAPP_ADDRESS'] || '';

// ---------------------------------------------------------------------------
// Anvil chain definition
// ---------------------------------------------------------------------------

export const anvilChain = defineChain({
  id: CHAIN_ID,
  name: 'anvil',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [ANVIL_RPC] } },
});

// ---------------------------------------------------------------------------
// ABIs
// ---------------------------------------------------------------------------

export const TOKEN_NETWORK_ABI = [
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

export const ERC20_ABI = [
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
export const BALANCE_PROOF_TYPES = {
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

export function createViemClient() {
  return createPublicClient({
    chain: anvilChain,
    transport: http(ANVIL_RPC),
  });
}

export async function getChannelState(channelId: Hex) {
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

export async function getParticipantInfo(channelId: Hex, participant: Hex) {
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

export async function getTokenBalance(address: Hex): Promise<bigint> {
  const client = createViemClient();
  return client.readContract({
    address: TOKEN_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [address],
  });
}

export async function getChannelCounter(): Promise<bigint> {
  const client = createViemClient();
  return client.readContract({
    address: TOKEN_NETWORK_ADDRESS,
    abi: TOKEN_NETWORK_ABI,
    functionName: 'channelCounter',
    args: [],
  });
}

export function waitForEventOnRelay(
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

export async function waitForServiceHealth(
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

export async function waitForRelayReady(
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
export async function waitForPeer2Bootstrap(timeoutMs = 45000): Promise<boolean> {
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

/**
 * Perform health checks on all Docker SDK E2E services.
 * Returns true if all services are ready.
 */
export async function checkAllServicesReady(): Promise<boolean> {
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
      return false;
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
      return false;
    }

    return true;
  } catch (error) {
    console.warn(
      `Docker SDK E2E infra not running: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

/**
 * Skip check for E2E tests. In CI, throws; locally, logs and returns true to skip.
 */
export async function waitForSolanaHealth(timeoutMs = 30000): Promise<boolean> {
  return waitForServiceHealth(`${SOLANA_RPC}/health`, timeoutMs);
}

export async function waitForMinaHealth(timeoutMs = 180000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(MINA_GRAPHQL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '{syncStatus}' }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = (await res.json()) as Record<string, unknown>;
        const syncData = data['data'] as Record<string, unknown> | undefined;
        if (syncData?.['syncStatus'] === 'SYNCED') return true;
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

export async function acquireMinaAccount(): Promise<{ pk: string; sk: string } | null> {
  try {
    const res = await fetch(`${MINA_ACCOUNTS_MANAGER}/acquire-account`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      return (await res.json()) as { pk: string; sk: string };
    }
  } catch {
    // non-fatal
  }
  return null;
}

export async function releaseMinaAccount(pk: string): Promise<void> {
  try {
    await fetch(`${MINA_ACCOUNTS_MANAGER}/release-account?pk=${pk}`, {
      method: 'PUT',
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // non-fatal
  }
}

export function skipIfNotReady(servicesReady: boolean): boolean {
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

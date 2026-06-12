/**
 * Shared Docker E2E test infrastructure.
 *
 * Constants, ABIs, chain definitions, and helper functions used across
 * all Docker-based E2E tests. Extracted from docker-publish-event-e2e.test.ts
 * to avoid duplication.
 *
 * Prerequisites: SDK E2E infrastructure running via `./scripts/sdk-e2e-infra.sh up`
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  parseEther,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import WebSocket from 'ws';
import { decodeEventFromToon } from '@toon-protocol/relay';

// Repo root resolved from this file's location, independent of process.cwd().
// File path: <repo>/packages/sdk/tests/e2e/helpers/docker-e2e-setup.ts → walk up 5 levels.
const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../..'
);

// Load .env.sdk-e2e if present (written by ./scripts/sdk-e2e-infra.sh up / --public).
// Resolved from REPO_ROOT, not process.cwd(), so it works regardless of where
// vitest is invoked. MUST run before the env-overridable constants below so the
// EVM/Solana/Mina values (testnet endpoints + derived keys in public mode) are
// visible when those exports are evaluated. process.env (CI) always wins — the
// loader only fills keys that are unset/empty.
function loadSdkE2eEnv(): void {
  try {
    const envPath = resolve(REPO_ROOT, '.env.sdk-e2e');
    if (!existsSync(envPath)) return;
    const content = readFileSync(envPath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
      if (match) {
        const [, key, value] = match;
        if (process.env[key] === undefined || process.env[key] === '') {
          process.env[key] = value;
        }
      }
    }
  } catch {
    // non-fatal — env var may already be set
  }
}
loadSdkE2eEnv();

// ---------------------------------------------------------------------------
// Constants (Docker SDK E2E ports — see docker-compose-sdk-e2e.yml)
//
// The EVM RPC / chain-id / contract addresses / client keys default to the
// local Anvil stack but are overridable via env (written into .env.sdk-e2e by
// `sdk-e2e-infra.sh --public`, or injected directly in CI). This lets the same
// helper drive both the local Anvil stack and the public Base-Sepolia testnet
// run without code changes — mirroring SOLANA_PROGRAM_ID / MINA_ZKAPP_ADDRESS.
// ---------------------------------------------------------------------------

export const ANVIL_RPC = process.env['EVM_RPC_URL'] || 'http://localhost:18545';

// Peer 1 (Docker — genesis-like)
export const PEER1_RELAY_URL = 'ws://localhost:19700';
export const PEER1_BTP_URL = 'ws://localhost:19000';
export const PEER1_BLS_URL = 'http://localhost:19100';
export const PEER1_EVM_ADDRESS =
  '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const; // Anvil Account #0

// Peer 2 (Docker — bootstraps from peer1)
export const PEER2_RELAY_URL = 'ws://localhost:19710';
export const PEER2_BLS_URL = 'http://localhost:19110';

// Contracts — Anvil defaults; overridable for the public Base-Sepolia run via
// EVM_TOKEN_ADDRESS / EVM_TOKEN_NETWORK_ADDRESS / EVM_REGISTRY_ADDRESS.
export const TOKEN_ADDRESS = (process.env['EVM_TOKEN_ADDRESS'] ||
  '0x5FbDB2315678afecb367f032d93F642f64180aa3') as `0x${string}`; // Mock USDC (Anvil default)
export const TOKEN_NETWORK_ADDRESS = (process.env[
  'EVM_TOKEN_NETWORK_ADDRESS'
] || '0xCafac3dD18aC6c6e92c921884f9E4176737C052c') as `0x${string}`;
export const REGISTRY_ADDRESS = (process.env['EVM_REGISTRY_ADDRESS'] ||
  '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512') as `0x${string}`;

// Per-test-file Anvil accounts to avoid nonce contention.
// Docker infra uses: Account #0 (peer1), Account #2 (peer2).
// Each test file gets its own account so concurrent tests don't conflict.
//
// In public mode these client/settlement actors must be FUNDED on the testnet,
// so the canonical pay-to-write + settlement keys are overridable via env. The
// harness (`sdk-e2e-infra.sh --public`) derives them from E2E_DEV_MNEMONIC at
// dedicated indices (client idx3, settlement A idx4, settlement B idx5) and the
// funder must fund those addresses (see docs/e2e-testnets.md).

// Account #3 (Anvil) — docker-publish-event-e2e; public: EVM_CLIENT_* (idx3)
export const TEST_PRIVATE_KEY = (process.env['EVM_CLIENT_PRIVATE_KEY'] ||
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6') as `0x${string}`;
export const TEST_EVM_ADDRESS = (process.env['EVM_CLIENT_ADDRESS'] ||
  '0x90F79bf6EB2c4f870365E785982E1f101E93b906') as `0x${string}`;

// Account #4 (Anvil) — settlement tests; public: EVM_SETTLEMENT_PRIVATE_KEY_A (idx4)
export const SETTLEMENT_PRIVATE_KEY_A = (process.env[
  'EVM_SETTLEMENT_PRIVATE_KEY_A'
] ||
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a') as `0x${string}`;
// Account #5 (Anvil) — settlement tests; public: EVM_SETTLEMENT_PRIVATE_KEY_B (idx5)
export const SETTLEMENT_PRIVATE_KEY_B = (process.env[
  'EVM_SETTLEMENT_PRIVATE_KEY_B'
] ||
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba') as `0x${string}`;

// Account #6 — docker-workflow-chain-e2e.
// Each suite signs its OWN on-chain channel txs, so each needs its OWN funded
// EVM key. Local mode (Anvil) uses the well-known accounts below; public mode
// overrides them with mnemonic-derived, treasury-funded keys (idx6-10) the
// harness writes to .env.sdk-e2e (scripts/e2e-derive-peer-config.mjs +
// scripts/fund-e2e-peers.mjs). Without the override, public runs hit
// INSUFFICIENT_FUNDS opening channels on Base Sepolia.
export const WORKFLOW_PRIVATE_KEY = (process.env['EVM_WORKFLOW_PRIVATE_KEY'] ||
  '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e') as `0x${string}`;
// Account #7 — docker-dvm-lifecycle-e2e
export const DVM_LIFECYCLE_PRIVATE_KEY = (process.env[
  'EVM_DVM_LIFECYCLE_PRIVATE_KEY'
] ||
  '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356') as `0x${string}`;
// Account #8 — docker-dvm-submission-e2e
export const DVM_SUBMISSION_PRIVATE_KEY = (process.env[
  'EVM_DVM_SUBMISSION_PRIVATE_KEY'
] ||
  '0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97') as `0x${string}`;
// Account #9 — docker-swarm-e2e
export const SWARM_PRIVATE_KEY = (process.env['EVM_SWARM_PRIVATE_KEY'] ||
  '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6') as `0x${string}`;
// Account #10 — docker-pet-dvm-e2e
export const PET_DVM_PRIVATE_KEY = (process.env['EVM_PET_DVM_PRIVATE_KEY'] ||
  '0xf214f2b2cd398c806f84e317254e0f0b801d0643303237d97a22a48e01628897') as `0x${string}`;

// 31337 (Anvil) by default; 84532 (Base Sepolia) in public mode via EVM_CHAIN_ID.
export const CHAIN_ID = Number(process.env['EVM_CHAIN_ID'] || 31337);

// Multi-chain constants
export const SOLANA_RPC = 'http://localhost:19899';
export const SOLANA_WS = 'ws://localhost:19900';
export const MINA_GRAPHQL = 'http://localhost:19085/graphql';
export const MINA_ACCOUNTS_MANAGER = 'http://localhost:19181';

function deriveSolanaProgramIdFromKeypair(): string | null {
  try {
    const kpPath = resolve(
      REPO_ROOT,
      'contracts/solana/payment_channel-keypair.json'
    );
    const raw = readFileSync(kpPath, 'utf8');
    const kp = JSON.parse(raw) as number[];
    if (kp.length < 64) return null;
    const pubkey = Uint8Array.from(kp.slice(32, 64));
    // Base58 encode (same alphabet as SDK identity module)
    const alphabet =
      '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let val = 0n;
    for (const b of pubkey) val = val * 256n + BigInt(b);
    let result = '';
    while (val > 0n) {
      result = alphabet[Number(val % 58n)] + result;
      val = val / 58n;
    }
    for (const b of pubkey) {
      if (b === 0) result = '1' + result;
      else break;
    }
    return result || '1';
  } catch {
    return null;
  }
}

export const SOLANA_PROGRAM_ID =
  process.env['SOLANA_PROGRAM_ID'] || deriveSolanaProgramIdFromKeypair() || '';
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
    inputs: [{ name: 'channelId', type: 'bytes32' }],
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

/**
 * Resolve the EVM settlement (channel-participant) key a host-side ephemeral
 * test connector should use to open its on-demand channel with peer1.
 *
 * ## Why this exists (issue #191)
 *
 * Each host-side test connector opens a payment channel with peer1 via its
 * `chainProviders[].keyId` participant. The Raiden-style `TokenNetwork` allows
 * only ONE channel per (participant1, participant2) pair.
 *
 * - **Local mode (Anvil, CHAIN_ID === 31337):** the chain reverts every run, so
 *   a DETERMINISTIC key is fine — no prior channel survives. This helper is a
 *   pure pass-through: it returns `funderKey` unchanged, performs no funding,
 *   and preserves the well-known deterministic Anvil accounts byte-for-byte.
 *
 * - **Public mode (persistent testnet, e.g. Base Sepolia CHAIN_ID 84532):** a
 *   channel opened by `funderKey` in a PRIOR run still exists on-chain, so
 *   re-opening with the same participant reverts with `InvalidChannelState()`
 *   (0xf806e9d9), and with no channel claim-generation can't resolve the
 *   TokenNetwork (errorCode T00). To guarantee a brand-new channel every run we
 *   generate a FRESH key (fresh participant ⇒ fresh channelId ⇒ no collision)
 *   and JUST-IN-TIME fund it from `funderKey`: a little native ETH for gas and a
 *   little MockUSDC for the channel deposit. We WAIT for both receipts before
 *   returning so the connector can immediately open + deposit.
 *
 * Multi-connector suites MUST call this once PER connector so each ephemeral
 * connector gets its OWN fresh participant (distinct channelId).
 *
 * @param funderKey the already-funded EVM key for this suite/connector (in
 *   public mode the idx6–11 treasury-funded keys the harness writes to
 *   `.env.sdk-e2e`; in local mode the deterministic Anvil account).
 * @returns the key the connector should use as its channel participant —
 *   `funderKey` unchanged on Anvil, or a freshly-funded `0x…` key in public mode.
 */
export async function publicModeSettlementKey(funderKey: Hex): Promise<Hex> {
  // Local Anvil: deterministic accounts, no persistent channel — pass through.
  if (CHAIN_ID === 31337) return funderKey;

  // Public mode: mint a fresh participant and fund it just-in-time so this run
  // opens a brand-new channel with peer1 (no InvalidChannelState collision).
  const freshKey = generatePrivateKey();
  const freshAccount = privateKeyToAccount(freshKey);
  const funderAccount = privateKeyToAccount(funderKey);

  const publicClient = createViemClient();
  const walletClient = createWalletClient({
    account: funderAccount,
    chain: anvilChain,
    transport: http(ANVIL_RPC),
  });

  // Gas: a small native top-up. Channel open/deposit is a couple of txs.
  // MockUSDC is 18-decimal; channel deposits are tiny (~0x015180 base units ≈
  // 88064 wei-scale), so fund a small amount with generous margin.
  const ethForGas = parseEther('0.003');
  const usdcForDeposit = 10_000_000_000_000_000n; // 0.01 MockUSDC (18 decimals)

  // 1) Native ETH for gas.
  const ethTx = await walletClient.sendTransaction({
    to: freshAccount.address,
    value: ethForGas,
  });
  // 2) MockUSDC for the channel deposit.
  const usdcTx = await walletClient.writeContract({
    address: TOKEN_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [freshAccount.address, usdcForDeposit],
    // Explicit gas: public RPCs sometimes underestimate a cold-recipient
    // transfer (cold SSTORE) and the auto-estimate can revert.
    gas: 100_000n,
  });

  // Wait for BOTH receipts before returning so the connector can open+deposit.
  await Promise.all([
    publicClient.waitForTransactionReceipt({ hash: ethTx }),
    publicClient.waitForTransactionReceipt({ hash: usdcTx }),
  ]);

  return freshKey;
}

export async function getChannelState(channelId: Hex) {
  const client = createViemClient();
  const result = await client.readContract({
    address: TOKEN_NETWORK_ADDRESS,
    abi: TOKEN_NETWORK_ABI,
    functionName: 'channels',
    args: [channelId],
  });

  const [
    settlementTimeout,
    state,
    closedAt,
    openedAt,
    participant1,
    participant2,
  ] = result;

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

  const [deposit, nonce, transferredAmount] = result;
  return { deposit, nonce, transferredAmount };
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
export async function waitForPeer2Bootstrap(
  timeoutMs = 45000
): Promise<boolean> {
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

export async function acquireMinaAccount(): Promise<{
  pk: string;
  sk: string;
} | null> {
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
      throw new Error('Docker SDK E2E services not ready — cannot run in CI.');
    }
    console.log('Skipping: Docker SDK E2E infra not ready');
    return true;
  }
  return false;
}

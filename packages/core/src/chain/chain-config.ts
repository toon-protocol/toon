/**
 * Multi-environment chain configuration for Crosstown relay nodes.
 *
 * Provides chain presets for three deployment environments:
 * - **anvil** (local dev): Deterministic Anvil addresses, localhost RPC
 * - **arbitrum-sepolia** (staging): Circle testnet USDC on Arbitrum Sepolia
 * - **arbitrum-one** (production): Native USDC on Arbitrum One
 *
 * Environment variable overrides:
 * - `CROSSTOWN_CHAIN` overrides the config-level chain parameter
 * - `CROSSTOWN_RPC_URL` overrides the preset RPC endpoint
 * - `CROSSTOWN_TOKEN_NETWORK` overrides the preset TokenNetwork address
 *
 * @module
 */

import { CrosstownError } from '../errors.js';
import { MOCK_USDC_ADDRESS } from './usdc.js';

// ---------- Types ----------

/**
 * Supported chain preset names.
 */
export type ChainName = 'anvil' | 'arbitrum-sepolia' | 'arbitrum-one';

/**
 * Resolved chain configuration with all fields populated.
 */
export interface ChainPreset {
  /** Preset identifier ('anvil' | 'arbitrum-sepolia' | 'arbitrum-one'). */
  name: string;
  /** EVM chain ID. */
  chainId: number;
  /** Default RPC endpoint URL. */
  rpcUrl: string;
  /** USDC token contract address on this chain. */
  usdcAddress: string;
  /** TokenNetwork contract address for USDC on this chain. */
  tokenNetworkAddress: string;
}

// ---------- Presets ----------

/**
 * Built-in chain presets for supported deployment environments.
 *
 * Each preset provides the chainId, RPC URL, USDC address, and
 * TokenNetwork address for its environment. Fields can be overridden
 * at runtime via environment variables.
 */
export const CHAIN_PRESETS: Record<ChainName, ChainPreset> = {
  anvil: {
    name: 'anvil',
    chainId: 31337,
    rpcUrl: 'http://localhost:8545',
    usdcAddress: MOCK_USDC_ADDRESS,
    tokenNetworkAddress: '0xCafac3dD18aC6c6e92c921884f9E4176737C052c',
  },
  'arbitrum-sepolia': {
    name: 'arbitrum-sepolia',
    chainId: 421614,
    rpcUrl: 'https://sepolia-rollup.arbitrum.io/rpc',
    usdcAddress: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
    tokenNetworkAddress: '',
  },
  'arbitrum-one': {
    name: 'arbitrum-one',
    chainId: 42161,
    rpcUrl: 'https://arb1.arbitrum.io/rpc',
    usdcAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    tokenNetworkAddress: '',
  },
};

// ---------- Functions ----------

/**
 * Resolve chain configuration from a chain name, with environment
 * variable overrides applied.
 *
 * Resolution order:
 * 1. `CROSSTOWN_CHAIN` env var overrides the `chain` parameter
 * 2. Defaults to `'anvil'` if neither is provided
 * 3. Looks up the chain name in `CHAIN_PRESETS`
 * 4. `CROSSTOWN_RPC_URL` env var overrides the preset's `rpcUrl`
 * 5. `CROSSTOWN_TOKEN_NETWORK` env var overrides the preset's `tokenNetworkAddress`
 *
 * Returns a defensive copy -- callers can mutate the result without
 * affecting the shared preset objects.
 *
 * @param chain - Chain name to resolve (default: 'anvil')
 * @returns Resolved chain preset with env var overrides applied
 * @throws CrosstownError if the chain name is not recognized
 */
export function resolveChainConfig(chain?: ChainName | string): ChainPreset {
  // 1. CROSSTOWN_CHAIN env var overrides the parameter
  const envChain = process.env['CROSSTOWN_CHAIN'];
  const name = envChain || chain || 'anvil';

  // 2. Look up the chain name in presets
  const preset = CHAIN_PRESETS[name as ChainName];
  if (!preset) {
    throw new CrosstownError(
      `Unknown chain "${name}". Valid chains: anvil, arbitrum-sepolia, arbitrum-one`,
      'INVALID_CHAIN'
    );
  }

  // 3. Create defensive copy
  const resolved: ChainPreset = { ...preset };

  // 4. CROSSTOWN_RPC_URL env var overrides preset rpcUrl
  const envRpcUrl = process.env['CROSSTOWN_RPC_URL'];
  if (envRpcUrl) {
    resolved.rpcUrl = envRpcUrl;
  }

  // 5. CROSSTOWN_TOKEN_NETWORK env var overrides preset tokenNetworkAddress
  const envTokenNetwork = process.env['CROSSTOWN_TOKEN_NETWORK'];
  if (envTokenNetwork) {
    resolved.tokenNetworkAddress = envTokenNetwork;
  }

  return resolved;
}

/**
 * Build an EIP-712 domain separator from a resolved chain configuration.
 *
 * The returned domain matches the structure used by
 * `getBalanceProofDomain()` in `packages/client/src/signing/evm-signer.ts`:
 *
 * ```typescript
 * { name: 'TokenNetwork', version: '1', chainId, verifyingContract }
 * ```
 *
 * Since `@crosstown/core` does not depend on viem, the `verifyingContract`
 * field is typed as `string` (not viem's `Hex`). Consumers in the client
 * package can cast to `Hex` if needed.
 *
 * @param config - Resolved chain preset
 * @returns EIP-712 domain separator object
 */
export function buildEip712Domain(config: ChainPreset): {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
} {
  return {
    name: 'TokenNetwork',
    version: '1',
    chainId: config.chainId,
    verifyingContract: config.tokenNetworkAddress,
  };
}

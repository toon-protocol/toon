/**
 * Multi-environment chain configuration for TOON relay nodes.
 *
 * Provides chain presets for three blockchain families:
 * - **EVM**: Anvil (local dev), Arbitrum Sepolia (staging), Arbitrum One (production)
 * - **Solana**: solana-devnet (local dev)
 * - **Mina**: mina-devnet (local dev)
 *
 * Environment variable overrides:
 * - `TOON_CHAIN` overrides the config-level chain parameter
 * - `TOON_RPC_URL` overrides the preset RPC endpoint
 * - `TOON_TOKEN_NETWORK` overrides the preset TokenNetwork address
 *
 * @module
 */

import { ToonError } from '../errors.js';
import { MOCK_USDC_ADDRESS } from './usdc.js';

// ---------- Types ----------

/**
 * Blockchain family type. Matches the connector's BlockchainType.
 */
export type ChainType = 'evm' | 'solana' | 'mina';

/**
 * Supported EVM chain preset names (backward-compatible).
 */
export type ChainName = 'anvil' | 'arbitrum-sepolia' | 'arbitrum-one';

/**
 * Supported Solana chain preset names.
 */
export type SolanaChainName = 'solana-devnet';

/**
 * Supported Mina chain preset names.
 */
export type MinaChainName = 'mina-devnet';

/**
 * All supported chain preset names across all chain types.
 */
export type MultiChainName = ChainName | SolanaChainName | MinaChainName;

/**
 * Resolved EVM chain configuration with all fields populated.
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
  /** TokenNetworkRegistry contract address on this chain. */
  registryAddress: string;
}

/**
 * Resolved Solana chain configuration.
 */
export interface SolanaChainPreset {
  /** Preset identifier (e.g., 'solana-devnet'). */
  name: string;
  /** Chain type discriminator. */
  chainType: 'solana';
  /** Solana cluster RPC endpoint (HTTP). */
  rpcUrl: string;
  /** Payment channel program ID (base58-encoded). TBD until deployed. */
  programId: string;
  /** Solana cluster name for chain ID namespacing (e.g., 'devnet'). */
  cluster: string;
  /** Optional SPL token mint address. */
  tokenMint?: string;
}

/**
 * Resolved Mina chain configuration.
 */
export interface MinaChainPreset {
  /** Preset identifier (e.g., 'mina-devnet'). */
  name: string;
  /** Chain type discriminator. */
  chainType: 'mina';
  /** Mina GraphQL endpoint. */
  graphqlUrl: string;
  /** zkApp address for the payment channel contract. TBD until deployed. */
  zkAppAddress: string;
  /** Mina network name (e.g., 'devnet'). */
  network: string;
  /** Optional Mina token ID. */
  tokenId?: string;
}

// ---------- Chain Provider Config Entry ----------

/**
 * EVM-specific provider configuration entry.
 */
export interface EVMProviderConfigEntry {
  chainType: 'evm';
  chainId: string;
  rpcUrl: string;
  registryAddress: string;
  keyId: string;
}

/**
 * Solana-specific provider configuration entry.
 */
export interface SolanaProviderConfigEntry {
  chainType: 'solana';
  chainId: string;
  rpcUrl: string;
  programId: string;
  keyId: string;
  wsUrl?: string;
  cluster?: string;
  tokenMint?: string;
}

/**
 * Mina-specific provider configuration entry.
 */
export interface MinaProviderConfigEntry {
  chainType: 'mina';
  chainId: string;
  graphqlUrl: string;
  zkAppAddress: string;
  keyId?: string;
  tokenId?: string;
  network?: string;
}

/**
 * Discriminated union of all chain provider config entries.
 * Mirrors the connector's ChainProviderConfigEntry type for passthrough.
 */
export type ChainProviderConfigEntry =
  | EVMProviderConfigEntry
  | SolanaProviderConfigEntry
  | MinaProviderConfigEntry;

// ---------- Presets ----------

/**
 * Built-in EVM chain presets for supported deployment environments.
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
    registryAddress: '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512',
  },
  'arbitrum-sepolia': {
    name: 'arbitrum-sepolia',
    chainId: 421614,
    rpcUrl: 'https://sepolia-rollup.arbitrum.io/rpc',
    usdcAddress: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
    tokenNetworkAddress: '0x91d62b1F7C5d1129A64EE3915c480DBF288B1cBa',
    registryAddress: '',
  },
  'arbitrum-one': {
    name: 'arbitrum-one',
    chainId: 42161,
    rpcUrl: 'https://arb1.arbitrum.io/rpc',
    usdcAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    tokenNetworkAddress: '',
    registryAddress: '',
  },
};

// ---------- Functions ----------

/**
 * Resolve chain configuration from a chain name, with environment
 * variable overrides applied.
 *
 * Resolution order:
 * 1. `TOON_CHAIN` env var overrides the `chain` parameter
 * 2. Defaults to `'anvil'` if neither is provided
 * 3. Looks up the chain name in `CHAIN_PRESETS`
 * 4. `TOON_RPC_URL` env var overrides the preset's `rpcUrl`
 * 5. `TOON_TOKEN_NETWORK` env var overrides the preset's `tokenNetworkAddress`
 * 6. `TOON_REGISTRY_ADDRESS` env var overrides the preset's `registryAddress`
 *
 * Returns a defensive copy -- callers can mutate the result without
 * affecting the shared preset objects.
 *
 * @param chain - Chain name to resolve (default: 'anvil')
 * @returns Resolved chain preset with env var overrides applied
 * @throws ToonError if the chain name is not recognized
 */
export function resolveChainConfig(chain?: ChainName | string): ChainPreset {
  // 1. TOON_CHAIN env var overrides the parameter
  const envChain = process.env['TOON_CHAIN'];
  const name = envChain || chain || 'anvil';

  // 2. Look up the chain name in presets
  const preset = CHAIN_PRESETS[name as ChainName];
  if (!preset) {
    throw new ToonError(
      `Unknown chain "${name}". Valid chains: anvil, arbitrum-sepolia, arbitrum-one`,
      'INVALID_CHAIN'
    );
  }

  // 3. Create defensive copy
  const resolved: ChainPreset = { ...preset };

  // 4. TOON_RPC_URL env var overrides preset rpcUrl
  const envRpcUrl = process.env['TOON_RPC_URL'];
  if (envRpcUrl) {
    resolved.rpcUrl = envRpcUrl;
  }

  // 5. TOON_TOKEN_NETWORK env var overrides preset tokenNetworkAddress
  const envTokenNetwork = process.env['TOON_TOKEN_NETWORK'];
  if (envTokenNetwork) {
    resolved.tokenNetworkAddress = envTokenNetwork;
  }

  // 6. TOON_REGISTRY_ADDRESS env var overrides preset registryAddress
  const envRegistryAddress = process.env['TOON_REGISTRY_ADDRESS'];
  if (envRegistryAddress) {
    resolved.registryAddress = envRegistryAddress;
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
 * Since `@toon-protocol/core` does not depend on viem, the `verifyingContract`
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

// ---------- Solana Presets ----------

/**
 * Built-in Solana chain presets.
 */
export const SOLANA_CHAIN_PRESETS: Record<SolanaChainName, SolanaChainPreset> =
  {
    'solana-devnet': {
      name: 'solana-devnet',
      chainType: 'solana',
      rpcUrl: 'http://localhost:19899',
      programId: '', // TBD: set after program deployment
      cluster: 'devnet',
    },
  };

// ---------- Mina Presets ----------

/**
 * Built-in Mina chain presets.
 */
export const MINA_CHAIN_PRESETS: Record<MinaChainName, MinaChainPreset> = {
  'mina-devnet': {
    name: 'mina-devnet',
    chainType: 'mina',
    graphqlUrl: 'http://localhost:19085/graphql',
    zkAppAddress: '', // TBD: set after zkApp deployment
    network: 'devnet',
  },
};

// ---------- Multi-Chain Resolution ----------

/**
 * Resolve a Solana chain preset by name, with env var overrides.
 *
 * Environment variable overrides:
 * - `SOLANA_RPC_URL` overrides the preset's rpcUrl
 * - `SOLANA_PROGRAM_ID` overrides the preset's programId
 *
 * @param name - Solana chain preset name
 * @returns Resolved Solana chain preset
 * @throws ToonError if the name is not recognized
 */
export function resolveSolanaChainConfig(
  name: SolanaChainName
): SolanaChainPreset {
  const preset = SOLANA_CHAIN_PRESETS[name];
  if (!preset) {
    const validNames = Object.keys(SOLANA_CHAIN_PRESETS).join(', ');
    throw new ToonError(
      `Unknown Solana chain "${name}". Valid Solana chains: ${validNames}`,
      'INVALID_CHAIN'
    );
  }

  const resolved: SolanaChainPreset = { ...preset };

  const envRpcUrl = process.env['SOLANA_RPC_URL'];
  if (envRpcUrl) {
    resolved.rpcUrl = envRpcUrl;
  }

  const envProgramId = process.env['SOLANA_PROGRAM_ID'];
  if (envProgramId) {
    resolved.programId = envProgramId;
  }

  return resolved;
}

/**
 * Resolve a Mina chain preset by name, with env var overrides.
 *
 * Environment variable overrides:
 * - `MINA_GRAPHQL_URL` overrides the preset's graphqlUrl
 * - `MINA_ZKAPP_ADDRESS` overrides the preset's zkAppAddress
 *
 * @param name - Mina chain preset name
 * @returns Resolved Mina chain preset
 * @throws ToonError if the name is not recognized
 */
export function resolveMinaChainConfig(name: MinaChainName): MinaChainPreset {
  const preset = MINA_CHAIN_PRESETS[name];
  if (!preset) {
    const validNames = Object.keys(MINA_CHAIN_PRESETS).join(', ');
    throw new ToonError(
      `Unknown Mina chain "${name}". Valid Mina chains: ${validNames}`,
      'INVALID_CHAIN'
    );
  }

  const resolved: MinaChainPreset = { ...preset };

  const envGraphqlUrl = process.env['MINA_GRAPHQL_URL'];
  if (envGraphqlUrl) {
    resolved.graphqlUrl = envGraphqlUrl;
  }

  const envZkAppAddress = process.env['MINA_ZKAPP_ADDRESS'];
  if (envZkAppAddress) {
    resolved.zkAppAddress = envZkAppAddress;
  }

  return resolved;
}

/**
 * Build a ChainProviderConfigEntry from a resolved EVM chain preset.
 *
 * Converts the TOON-specific ChainPreset into the connector's
 * ChainProviderConfigEntry format for the `chainProviders` array.
 *
 * @param config - Resolved EVM chain preset
 * @param keyId - Key identifier for signing operations
 * @returns EVM chain provider config entry
 */
export function buildEvmProviderEntry(
  config: ChainPreset,
  keyId: string
): EVMProviderConfigEntry {
  return {
    chainType: 'evm',
    chainId: `evm:${config.chainId}`,
    rpcUrl: config.rpcUrl,
    registryAddress: config.registryAddress,
    keyId,
  };
}

/**
 * Build a ChainProviderConfigEntry from a resolved Solana chain preset.
 *
 * @param config - Resolved Solana chain preset
 * @param keyId - Key identifier for Ed25519 signing operations
 * @returns Solana chain provider config entry
 */
export function buildSolanaProviderEntry(
  config: SolanaChainPreset,
  keyId: string
): SolanaProviderConfigEntry {
  return {
    chainType: 'solana',
    chainId: `solana:${config.cluster}`,
    rpcUrl: config.rpcUrl,
    programId: config.programId,
    keyId,
    cluster: config.cluster,
    ...(config.tokenMint && { tokenMint: config.tokenMint }),
  };
}

/**
 * Build a ChainProviderConfigEntry from a resolved Mina chain preset.
 *
 * @param config - Resolved Mina chain preset
 * @param keyId - Optional key identifier for signing operations
 * @returns Mina chain provider config entry
 */
export function buildMinaProviderEntry(
  config: MinaChainPreset,
  keyId?: string
): MinaProviderConfigEntry {
  return {
    chainType: 'mina',
    chainId: `mina:${config.network}`,
    graphqlUrl: config.graphqlUrl,
    zkAppAddress: config.zkAppAddress,
    ...(keyId && { keyId }),
    ...(config.tokenId && { tokenId: config.tokenId }),
    network: config.network,
  };
}

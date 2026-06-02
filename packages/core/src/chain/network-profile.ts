/**
 * Network-mode resolution for the Townhouse `network` flag.
 *
 * A single operator-facing selector — `mainnet | testnet | devnet | custom` —
 * resolves a coherent multi-chain configuration that is consumed by BOTH:
 *
 * - the **apex** standalone connector (its `chainProviders` settlement array), and
 * - the **children** node containers (town/mill), via a small set of env vars the
 *   HS compose template interpolates (`EVM_CHAIN`, `EVM_RPC_URL`, `EVM_CHAIN_ID`,
 *   `EVM_USDC_ADDRESS`, `SOLANA_RPC_URL`, `SOLANA_USDC_MINT`).
 *
 * Design notes:
 * - **All tiers are public.** No tier resolves to a local chain (anvil/lightnet),
 *   so a node never points at an unreachable `localhost` RPC. This is what fixes
 *   the "JsonRpcProvider failed to detect network" boot-loop that left town nodes
 *   permanently disconnected (an empty RPC fell back to the `anvil` preset whose
 *   `localhost:8545` does not exist in the HS network).
 * - **EVM = Base (primary) + Arbitrum.** The single-EVM town node uses Base; the
 *   apex connector and Mill can hold providers for both families.
 * - **Honest settlement status.** TOON's own settlement contracts (EVM
 *   registry/TokenNetwork, Solana program, Mina zkApp) are NOT deployed to public
 *   chains yet, so every public family is currently `unconfigured` for settlement.
 *   The resolver emits real RPC + token addresses (balances, swap quotes) but only
 *   builds a connector `chainProviders` entry for a family once its on-chain
 *   addresses are present — until then nodes run relay-only. No addresses are
 *   invented; filling the presets later requires no change here.
 *
 * The low-level local `solana-devnet` / `mina-devnet` presets in chain-config.ts
 * (used by the dev/e2e stack) are intentionally NOT reused — this module defines
 * the public Solana/Mina endpoints itself.
 *
 * @module
 */

import {
  CHAIN_PRESETS,
  buildEvmProviderEntry,
  buildSolanaProviderEntry,
  buildMinaProviderEntry,
  type ChainName,
  type ChainPreset,
  type ChainProviderConfigEntry,
} from './chain-config.js';

/** Operator-facing network selector. */
export type NetworkMode = 'mainnet' | 'testnet' | 'devnet' | 'custom';

/** The three derivable tiers (everything except `custom`). */
type DerivableTier = Exclude<NetworkMode, 'custom'>;

/** Per-family settlement readiness, for honest UX. */
export interface NetworkFamilyStatus {
  /** `configured` once the family has on-chain settlement addresses for this tier. */
  evm: 'configured' | 'unconfigured';
  solana: 'configured' | 'unconfigured';
  mina: 'configured' | 'unconfigured';
}

/**
 * Env vars the HS compose template interpolates into the node containers.
 * Only keys with real values are present (absent ⇒ compose `${VAR:-}` default).
 */
export interface NetworkNodeEnv {
  /** Primary EVM chain preset name → town `TOON_CHAIN` (`'none'` ⇒ relay-only). */
  EVM_CHAIN?: string;
  EVM_RPC_URL?: string;
  EVM_CHAIN_ID?: string;
  EVM_USDC_ADDRESS?: string;
  SOLANA_RPC_URL?: string;
  SOLANA_USDC_MINT?: string;
}

/** Resolved network configuration for apex + children. */
export interface NetworkProfile {
  network: NetworkMode;
  /**
   * Connector `chainProviders` for the apex. Contains only settlement-complete
   * families (omitted when on-chain addresses are absent — the caller falls back
   * to its own default in that case).
   */
  chainProviders: ChainProviderConfigEntry[];
  /** Env overlay for the node containers. */
  nodeEnv: NetworkNodeEnv;
  /** Per-family settlement readiness. */
  status: NetworkFamilyStatus;
}

/** Sentinel for the town node meaning "no EVM settlement chain — run relay-only". */
export const RELAY_ONLY_CHAIN = 'none';

/** Primary + secondary EVM presets per derivable tier (Base is primary). */
const EVM_TIER: Record<
  DerivableTier,
  { primary: ChainName; also: ChainName[] }
> = {
  mainnet: { primary: 'base-mainnet', also: ['arbitrum-one'] },
  testnet: { primary: 'base-sepolia', also: ['arbitrum-sepolia'] },
  // EVM has no public devnet → the public Sepolia testnets serve the devnet tier.
  devnet: { primary: 'base-sepolia', also: ['arbitrum-sepolia'] },
};

interface SolanaTierCfg {
  rpcUrl: string;
  cluster: string;
  usdcMint: string;
  programId: string;
}

/** Public Solana endpoints per tier (the low-level presets are local-only). */
const SOLANA_TIER: Record<DerivableTier, SolanaTierCfg> = {
  mainnet: {
    rpcUrl: 'https://api.mainnet-beta.solana.com',
    cluster: 'mainnet-beta',
    usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    programId: '', // TOON payment-channel program not deployed yet
  },
  testnet: {
    rpcUrl: 'https://api.testnet.solana.com',
    cluster: 'testnet',
    usdcMint: '', // no canonical USDC on Solana testnet
    programId: '',
  },
  devnet: {
    rpcUrl: 'https://api.devnet.solana.com',
    cluster: 'devnet',
    usdcMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    programId: '',
  },
};

interface MinaTierCfg {
  graphqlUrl: string;
  network: string;
  zkAppAddress: string;
}

/** Public Mina endpoints per tier (Mina has no separate testnet → uses devnet). */
const MINA_TIER: Record<DerivableTier, MinaTierCfg> = {
  mainnet: {
    graphqlUrl: 'https://api.minascan.io/node/mainnet/v1/graphql',
    network: 'mainnet',
    zkAppAddress: '', // TOON payment-channel zkApp not deployed yet
  },
  testnet: {
    graphqlUrl: 'https://api.minascan.io/node/devnet/v1/graphql',
    network: 'devnet',
    zkAppAddress: '',
  },
  devnet: {
    graphqlUrl: 'https://api.minascan.io/node/devnet/v1/graphql',
    network: 'devnet',
    zkAppAddress: '',
  },
};

/** An EVM preset is settlement-complete when registry + tokenNetwork are deployed. */
function evmSettlementComplete(p: ChainPreset): boolean {
  return p.registryAddress !== '' && p.tokenNetworkAddress !== '';
}

/**
 * Resolve a {@link NetworkProfile} from a network mode.
 *
 * @param network - The operator-selected network mode.
 * @param opts.keyId - Settlement signing key for connector `chainProviders`
 *   entries. Required to emit settlement-complete providers; omit for the common
 *   relay-only case (no providers are built without it).
 * @param opts.customProviders - For `network: 'custom'`, the operator-supplied
 *   `chainProviders` to pass through verbatim (and to derive node env from).
 */
export function resolveNetworkProfile(
  network: NetworkMode,
  opts: { keyId?: string; customProviders?: ChainProviderConfigEntry[] } = {}
): NetworkProfile {
  if (network === 'custom') {
    return resolveCustom(opts.customProviders ?? []);
  }

  const tier = network as DerivableTier;
  const chainProviders: ChainProviderConfigEntry[] = [];
  const status: NetworkFamilyStatus = {
    evm: 'unconfigured',
    solana: 'unconfigured',
    mina: 'unconfigured',
  };

  // ── EVM (primary Base + secondary Arbitrum) ──
  const primary = CHAIN_PRESETS[EVM_TIER[tier].primary];
  const nodeEnv: NetworkNodeEnv = {
    EVM_CHAIN: primary.name,
    EVM_RPC_URL: primary.rpcUrl,
    EVM_CHAIN_ID: String(primary.chainId),
    EVM_USDC_ADDRESS: primary.usdcAddress,
  };

  if (opts.keyId) {
    for (const name of [EVM_TIER[tier].primary, ...EVM_TIER[tier].also]) {
      const preset = CHAIN_PRESETS[name];
      if (evmSettlementComplete(preset)) {
        chainProviders.push(buildEvmProviderEntry(preset, opts.keyId));
        status.evm = 'configured';
      }
    }
  }

  // ── Solana ──
  const sol = SOLANA_TIER[tier];
  nodeEnv.SOLANA_RPC_URL = sol.rpcUrl;
  if (sol.usdcMint) nodeEnv.SOLANA_USDC_MINT = sol.usdcMint;
  if (opts.keyId && sol.programId) {
    chainProviders.push(
      buildSolanaProviderEntry(
        {
          name: `solana-${sol.cluster}`,
          chainType: 'solana',
          rpcUrl: sol.rpcUrl,
          programId: sol.programId,
          cluster: sol.cluster,
          ...(sol.usdcMint && { tokenMint: sol.usdcMint }),
        },
        opts.keyId
      )
    );
    status.solana = 'configured';
  }

  // ── Mina ──
  const mina = MINA_TIER[tier];
  if (mina.zkAppAddress) {
    chainProviders.push(
      buildMinaProviderEntry(
        {
          name: `mina-${mina.network}`,
          chainType: 'mina',
          graphqlUrl: mina.graphqlUrl,
          zkAppAddress: mina.zkAppAddress,
          network: mina.network,
        },
        opts.keyId
      )
    );
    status.mina = 'configured';
  }

  return { network, chainProviders, nodeEnv, status };
}

/** Resolve the `custom` mode from operator-supplied providers. */
function resolveCustom(providers: ChainProviderConfigEntry[]): NetworkProfile {
  const status: NetworkFamilyStatus = {
    evm: 'unconfigured',
    solana: 'unconfigured',
    mina: 'unconfigured',
  };
  const nodeEnv: NetworkNodeEnv = {};

  const evm = providers.find((p) => p.chainType === 'evm');
  if (evm && evm.chainType === 'evm') {
    nodeEnv.EVM_RPC_URL = evm.rpcUrl;
    // chainId arrives as `evm:<numeric>` — strip the namespace for the node env.
    nodeEnv.EVM_CHAIN_ID = evm.chainId.replace(/^evm:/, '');
    nodeEnv.EVM_USDC_ADDRESS = evm.tokenAddress;
    // Custom EVM carries explicit addresses → let the node resolve via RPC override
    // rather than a named preset.
    nodeEnv.EVM_CHAIN = RELAY_ONLY_CHAIN;
    if (evm.registryAddress) status.evm = 'configured';
  } else {
    // No EVM in a custom config → town runs relay-only.
    nodeEnv.EVM_CHAIN = RELAY_ONLY_CHAIN;
  }

  const sol = providers.find((p) => p.chainType === 'solana');
  if (sol && sol.chainType === 'solana') {
    nodeEnv.SOLANA_RPC_URL = sol.rpcUrl;
    if (sol.tokenMint) nodeEnv.SOLANA_USDC_MINT = sol.tokenMint;
    if (sol.programId) status.solana = 'configured';
  }

  const mina = providers.find((p) => p.chainType === 'mina');
  if (mina && mina.chainType === 'mina' && mina.zkAppAddress) {
    status.mina = 'configured';
  }

  return { network: 'custom', chainProviders: providers, nodeEnv, status };
}

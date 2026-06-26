/**
 * Network-mode resolution for the TOON connector `network` flag.
 *
 * A single operator-facing selector — `mainnet | testnet | devnet | custom` —
 * resolves a coherent multi-chain configuration that is consumed by BOTH:
 * (`custom` additionally accepts operator RPC URLs via `--evm-url`/`--sol-url`
 * to point at the project's dev chains — e.g. the Akash-hosted anvil + solana.)
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
 * - **Settlement status.** TOON's settlement contracts are deployed for the
 *   public **testnet/devnet** tiers (EVM Base Sepolia registry + TokenNetwork,
 *   Solana devnet program, Mina devnet zkApp — source of truth: e2e/testnets.json),
 *   so those families resolve `configured` and the apex builds real
 *   `chainProviders` for them. **Mainnet remains unconfigured** (contracts not
 *   deployed there yet) → relay-only. The resolver only builds a connector
 *   `chainProviders` entry for a family once its on-chain addresses are present.
 *   No addresses are invented; filling the remaining (mainnet) presets later
 *   requires no change here. The deployed testnet/devnet addresses are
 *   maintained in sync with e2e/testnets.json (the one-time public deploy).
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

/** The three preset-derivable public tiers (everything except custom). */
type DerivableTier = Exclude<NetworkMode, 'custom'>;

/**
 * Operator-supplied RPC URLs for `network: 'custom'`
 * (`--evm-url` / `--sol-url`). Use this to point the apex + nodes at the
 * project's dev chains hosted anywhere — e.g. the anvil + solana that
 * scripts/akash-deploy.sh deploys to Akash (whose ingress hostnames rotate per
 * redeploy, so the operator passes the current URLs). The EVM chain is assumed
 * to be the chain-id 31338 `akash-anvil` deploy (deterministic TOON settlement
 * contracts → settlement-complete); Solana is RPC + Mock-USDC (relay-only, no
 * program). For arbitrary real chains with their own contracts, use the full
 * `customProviders` (chains editor) path instead.
 */
export interface CustomEndpoints {
  /** EVM JSON-RPC URL (the project's anvil deploy). */
  evmUrl?: string;
  /** Solana JSON-RPC URL. */
  solUrl?: string;
}

/**
 * Dev-chain templates for the URL-only custom path. The EVM chain is the
 * `anvil` preset — chain-id **31337** with the deterministic Foundry TOON
 * contracts (settlement-complete). This matches what scripts/akash-deploy.sh
 * actually deploys: the SDL pins `CHAIN_ID=31337` so the Akash anvil lines up
 * with the `anvil` preset (verified live: eth_chainId → 0x7a69, registry +
 * tokenNetwork have code). The operator's `--evm-url` overrides the preset's
 * localhost rpcUrl. The Solana node bootstraps a known Mock-USDC mint but the
 * payment-channel program is not deployed → Solana relay-only.
 */
const DEV_EVM_PRESET = 'anvil' as const;
const DEV_SOLANA = {
  usdcMint: '6GbdrVghwNKTz9raga7y3Y4qqX5Zgg3AC4d48Kt7C59Q',
  programId: '', // TOON payment-channel program not deployed on the dev Solana node
};

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
  /** Solana payment-channel program id (filled per-deploy; empty in presets). */
  SOLANA_PROGRAM_ID?: string;
  /** Mina payment-channel zkApp address (filled per-deploy; empty in presets). */
  MINA_ZKAPP_ADDRESS?: string;
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

/**
 * TOON's deployed public-testnet Solana settlement (Solana devnet). Source of
 * truth: e2e/testnets.json. The TokenNetwork program + its mint are live, so
 * this is settlement-complete. The `testnet` tier reuses the devnet cluster
 * because TOON has no deployment on Solana's `testnet` cluster — there is one
 * public deployment and both operator-facing tiers resolve to it.
 */
const SOLANA_DEPLOYED_DEVNET: SolanaTierCfg = {
  rpcUrl: 'https://api.devnet.solana.com',
  cluster: 'devnet',
  usdcMint: '9FtYCXjNiGDn17jSGvZuB5P4dZAKgVxUsDiQpLc8rbWy',
  programId: 'EdJxYPDxGvaJuu57DSUptf4soLv8enpdyQJJhHDLiydG',
};

/** Public Solana endpoints per tier (the low-level presets are local-only). */
const SOLANA_TIER: Record<DerivableTier, SolanaTierCfg> = {
  mainnet: {
    rpcUrl: 'https://api.mainnet-beta.solana.com',
    cluster: 'mainnet-beta',
    usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    programId: '', // TOON payment-channel program not deployed on mainnet
  },
  testnet: SOLANA_DEPLOYED_DEVNET,
  devnet: SOLANA_DEPLOYED_DEVNET,
};

interface MinaTierCfg {
  graphqlUrl: string;
  network: string;
  zkAppAddress: string;
}

/**
 * TOON's deployed public-testnet Mina settlement (Mina devnet). Source of truth:
 * e2e/testnets.json. Mina has no separate `testnet` network → both the testnet
 * and devnet tiers resolve to the one deployed devnet zkApp.
 */
const MINA_DEPLOYED_DEVNET: MinaTierCfg = {
  graphqlUrl: 'https://api.minascan.io/node/devnet/v1/graphql',
  network: 'devnet',
  // Reconciled with e2e/testnets.json (#205): the previous address
  // (B62qjFgX…) is a bare, unfunded zkApp on-chain (balance 0, channel
  // nonceField 0) — usable for claim issuance only. This is the funded,
  // on-chain-settling PaymentChannel zkApp (balance ~4 MINA, nonceField 21
  // — the on-chain settle proven in #217), same VK hash 21482326…
  zkAppAddress: 'B62qrH1As4odHiNyKpTZMHaM6tRs6gi5DJ53efZKQBtbaR5CUctbDs6',
};

/** Public Mina endpoints per tier (Mina has no separate testnet → uses devnet). */
const MINA_TIER: Record<DerivableTier, MinaTierCfg> = {
  mainnet: {
    graphqlUrl: 'https://api.minascan.io/node/mainnet/v1/graphql',
    network: 'mainnet',
    zkAppAddress: '', // TOON payment-channel zkApp not deployed on mainnet
  },
  testnet: MINA_DEPLOYED_DEVNET,
  devnet: MINA_DEPLOYED_DEVNET,
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
 * @param opts.endpoints - For `network: 'custom'`, operator-supplied RPC URLs
 *   (`--evm-url` / `--sol-url`) pointing at the project's dev chains. Used when
 *   `customProviders` is empty (the lightweight URL-only path).
 */
export function resolveNetworkProfile(
  network: NetworkMode,
  opts: {
    keyId?: string;
    customProviders?: ChainProviderConfigEntry[];
    endpoints?: CustomEndpoints;
  } = {}
): NetworkProfile {
  if (network === 'custom') {
    return resolveCustom(
      opts.customProviders ?? [],
      opts.endpoints ?? {},
      opts.keyId
    );
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
  // Gated on keyId for parity with EVM/Solana: a connector settlement provider
  // is only useful with a signing key, and `status` tracks apex settlement
  // readiness (the apex always resolves with a keyId; child node-env never does).
  const mina = MINA_TIER[tier];
  if (opts.keyId && mina.zkAppAddress) {
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

/**
 * Client-facing per-chain settlement presets resolved from a network mode.
 *
 * Where {@link NetworkProfile} targets the apex connector + node containers
 * (env overlay + `chainProviders`), this targets the @toon-protocol/client
 * `ToonClientConfig` shape: identifier-keyed maps (`evm:<name>:<chainId>`,
 * `solana:<cluster>`, `mina:<network>`) plus the Solana/Mina channel params.
 * It draws from the SAME presets (`CHAIN_PRESETS`, `SOLANA_TIER`, `MINA_TIER`),
 * so node and client default to the identical live contracts — no duplicated
 * address tables in the client package.
 *
 * Only `mainnet | testnet | devnet` are resolvable here; `custom` is the
 * client's fully-manual path and is intentionally not handled.
 */
export interface ClientNetworkPresets {
  /** Chain identifiers (`evm:base:84532`, `solana:devnet`, `mina:devnet`). */
  supportedChains: string[];
  /** identifier → JSON-RPC / GraphQL URL. */
  chainRpcUrls: Record<string, string>;
  /** identifier → preferred token (USDC / SPL mint) address. */
  preferredTokens: Record<string, string>;
  /** identifier → EVM TokenNetwork contract address (EVM only). */
  tokenNetworks: Record<string, string>;
  /** Solana channel params (rpcUrl + programId + tokenMint), if deployed. */
  solanaChannel?: { rpcUrl: string; programId: string; tokenMint?: string };
  /** Mina channel params (graphqlUrl + zkAppAddress + networkId), if deployed. */
  minaChannel?: {
    graphqlUrl: string;
    zkAppAddress: string;
    networkId: 'devnet' | 'mainnet';
  };
  /** Per-family settlement readiness (mirrors the node). */
  status: NetworkFamilyStatus;
}

/** EVM client identifier: `evm:<family>:<chainId>` (family = base/arbitrum/…). */
function evmClientId(preset: ChainPreset): string {
  const family = preset.name.split('-')[0] ?? preset.name;
  return `evm:${family}:${preset.chainId}`;
}

/**
 * Resolve {@link ClientNetworkPresets} for a derivable network tier.
 *
 * Mirrors {@link resolveNetworkProfile}'s address sourcing but emits the
 * client config shape. The EVM family is the tier's primary chain (Base);
 * Solana/Mina are the public tier endpoints. Only families with deployed TOON
 * contracts contribute settlement maps + channel params (others stay relay-only
 * and are reported `unconfigured`).
 */
export function resolveClientNetwork(
  network: DerivableTier
): ClientNetworkPresets {
  const supportedChains: string[] = [];
  const chainRpcUrls: Record<string, string> = {};
  const preferredTokens: Record<string, string> = {};
  const tokenNetworks: Record<string, string> = {};
  const status: NetworkFamilyStatus = {
    evm: 'unconfigured',
    solana: 'unconfigured',
    mina: 'unconfigured',
  };

  // ── EVM (primary Base) ──
  const evm = CHAIN_PRESETS[EVM_TIER[network].primary];
  const evmId = evmClientId(evm);
  supportedChains.push(evmId);
  chainRpcUrls[evmId] = evm.rpcUrl;
  if (evm.usdcAddress) preferredTokens[evmId] = evm.usdcAddress;
  if (evmSettlementComplete(evm)) {
    tokenNetworks[evmId] = evm.tokenNetworkAddress;
    status.evm = 'configured';
  }

  // ── Solana ──
  const sol = SOLANA_TIER[network];
  const solId = `solana:${sol.cluster}`;
  supportedChains.push(solId);
  chainRpcUrls[solId] = sol.rpcUrl;
  if (sol.usdcMint) preferredTokens[solId] = sol.usdcMint;
  let solanaChannel: ClientNetworkPresets['solanaChannel'];
  if (sol.programId) {
    solanaChannel = {
      rpcUrl: sol.rpcUrl,
      programId: sol.programId,
      ...(sol.usdcMint && { tokenMint: sol.usdcMint }),
    };
    status.solana = 'configured';
  }

  // ── Mina ──
  const mina = MINA_TIER[network];
  const minaId = `mina:${mina.network}`;
  supportedChains.push(minaId);
  chainRpcUrls[minaId] = mina.graphqlUrl;
  let minaChannel: ClientNetworkPresets['minaChannel'];
  if (mina.zkAppAddress) {
    minaChannel = {
      graphqlUrl: mina.graphqlUrl,
      zkAppAddress: mina.zkAppAddress,
      networkId: mina.network === 'mainnet' ? 'mainnet' : 'devnet',
    };
    status.mina = 'configured';
  }

  return {
    supportedChains,
    chainRpcUrls,
    preferredTokens,
    tokenNetworks,
    ...(solanaChannel && { solanaChannel }),
    ...(minaChannel && { minaChannel }),
    status,
  };
}

/**
 * Resolve the `custom` mode. Two operator paths:
 *   1. explicit `providers` (the chains editor / `chains add`) → used verbatim;
 *      the apex settles on them, the town node runs relay-only with their RPC.
 *   2. URL-only (`endpoints` from `--evm-url`/`--sol-url`) → point the apex +
 *      nodes at the project's dev chains (chain-id 31338 `akash-anvil`, which is
 *      settlement-complete; Solana RPC + Mock-USDC, relay-only).
 * `providers` takes precedence; with neither, the node runs relay-only.
 */
function resolveCustom(
  providers: ChainProviderConfigEntry[],
  endpoints: CustomEndpoints,
  keyId?: string
): NetworkProfile {
  if (providers.length === 0 && (endpoints.evmUrl || endpoints.solUrl)) {
    return resolveCustomEndpoints(endpoints, keyId);
  }

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

/**
 * URL-only custom path (`--evm-url` / `--sol-url`): point the apex + nodes at the
 * project's dev chains. EVM is the chain-id 31338 `akash-anvil` deploy
 * (settlement-complete via baked deterministic addresses); Solana is RPC +
 * Mock-USDC (relay-only). A family with no URL degrades to relay-only.
 */
function resolveCustomEndpoints(
  endpoints: CustomEndpoints,
  keyId?: string
): NetworkProfile {
  const evm = CHAIN_PRESETS[DEV_EVM_PRESET];
  const status: NetworkFamilyStatus = {
    evm: 'unconfigured',
    solana: 'unconfigured',
    mina: 'unconfigured',
  };
  const chainProviders: ChainProviderConfigEntry[] = [];

  // EVM_CHAIN points the town node at the akash-anvil preset (chain-id 31338 +
  // deterministic TOON contract addresses); EVM_RPC_URL supplies the operator's
  // URL, which the town overlays via TOON_RPC_URL.
  const nodeEnv: NetworkNodeEnv = {
    EVM_CHAIN: DEV_EVM_PRESET,
    EVM_CHAIN_ID: String(evm.chainId),
    EVM_USDC_ADDRESS: evm.usdcAddress,
  };

  if (endpoints.evmUrl) {
    nodeEnv.EVM_RPC_URL = endpoints.evmUrl;
    // akash-anvil carries registry + tokenNetwork → settlement-complete with a URL.
    status.evm = 'configured';
    if (keyId) {
      chainProviders.push(
        buildEvmProviderEntry({ ...evm, rpcUrl: endpoints.evmUrl }, keyId)
      );
    }
  } else {
    // No URL → akash-anvil preset rpcUrl is '' → town runs relay-only.
    nodeEnv.EVM_CHAIN = RELAY_ONLY_CHAIN;
  }

  if (endpoints.solUrl) {
    nodeEnv.SOLANA_RPC_URL = endpoints.solUrl;
    nodeEnv.SOLANA_USDC_MINT = DEV_SOLANA.usdcMint;
    // programId is empty → Solana settlement relay-only; no connector provider.
  }

  return { network: 'custom', chainProviders, nodeEnv, status };
}

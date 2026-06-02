/**
 * Public types for `buildSettlementTx()` (Story 12.6).
 *
 * @module
 * @since 12.6
 * @see _bmad-output/implementation-artifacts/12-6-build-settlement-tx.md
 */

import type { AccumulatedClaim } from '../stream-swap.js';
import type { MinaSignerClientLike } from './mina.js';

/**
 * Chain-specific raw settlement transaction bundle, produced by
 * `buildSettlementTx()`. Contains everything a Chain Bridge DVM
 * (Epic 13, kind:5260) or a direct sender needs to submit the settlement
 * on-chain.
 *
 * @stable — Epic 13 Chain Bridge DVM depends on this shape.
 * @since 12.6
 */
export interface SettlementBundle {
  /** Target chain identifier (e.g., `'evm:8453'`, `'evm:42161'`, `'solana:mainnet'`, `'mina:mainnet'`). */
  chain: string;
  /** Chain family — drives per-chain parsing. */
  chainKind: 'evm' | 'solana' | 'mina';
  /** Channel identifier on the target chain (lowercase hex with 0x prefix for EVM; base58 for Solana). */
  channelId: string;
  /** Cumulative transferred amount settled by this tx (target micro-units, decimal string). */
  cumulativeAmount: string;
  /** Balance-proof nonce settled by this tx (decimal string). */
  nonce: string;
  /** Recipient address (the sender's target-asset address — the one that will receive funds). */
  recipient: string;
  /** Mill's on-chain signer address (expected signer of the balance-proof signature). */
  millSignerAddress: string;
  /**
   * Raw UNSIGNED transaction bytes ready for the caller to sign (or for a
   * Chain Bridge DVM to gas-sponsor + sign). EVM: RLP-encoded tx with
   * placeholder gas fields (tx nonce / gasPrice / gasLimit = 0) per EIP-155.
   * Solana: serialized Message (not Transaction — Transaction requires signatures).
   * Mina: the verified balance-proof signature bytes (envelope). The final
   * on-chain `claimFromChannel` zkApp tx requires o1js proof generation and is
   * produced by a Mina-capable settler — see
   * `packages/sdk/src/settlement/mina.ts` (`TODO(mina-onchain)`).
   */
  unsignedTxBytes: Uint8Array;
  /**
   * Expected on-chain event signature (hex, 0x-prefixed keccak256 for EVM)
   * so a Chain Bridge DVM can watch for confirmation. Optional for
   * non-EVM chains that lack topic-based event signatures.
   */
  expectedEventSignature?: string;
  /**
   * Number of `AccumulatedClaim` inputs in THIS bundle's `(chain, channelId)`
   * group that survived signature verification.
   */
  claimsMerged: number;
  /** Index of the winning claim in the ORIGINAL input array (`BuildSettlementTxParams.claims`). */
  selectedClaimIndex: number;
  /** Source-asset chain of the SwapPair (for Chain Bridge bill-back). */
  sourceChain: string;
  /** Source-asset code of the SwapPair (for Chain Bridge bill-back). */
  sourceAssetCode: string;
}

/**
 * Per-chain Mill signer configuration.
 *
 * @since 12.6
 */
export interface MillSignerConfig {
  /**
   * Expected on-chain signer address for the Mill. EVM: 0x + 40 lowercase
   * hex chars. Solana: base58-encoded 32-byte Ed25519 pubkey. Mina: base58 pubkey.
   */
  address: string;
  /**
   * On-chain payment-channel contract address (EVM-only).
   */
  contractAddress?: string;
  /**
   * Solana on-chain program ID. Required for Solana claims.
   */
  programId?: string;
  /**
   * EVM chain-id (decimal). Required for EVM claims — baked into RLP per EIP-155.
   */
  chainId?: number;
}

/**
 * Parameters for `buildSettlementTx()`.
 *
 * @stable — Epic 13 Chain Bridge DVM depends on this shape.
 * @since 12.6
 */
export interface BuildSettlementTxParams {
  /** Claims to settle. Typically `streamSwapResult.claims`. MUST be non-empty. */
  claims: readonly AccumulatedClaim[];
  /** Per-chain Mill signer configuration. Keyed by `claim.pair.to.chain`. */
  signers: Record<string, MillSignerConfig>;
  /** Sender's target-asset address per chain. Keyed by `claim.pair.to.chain`. */
  recipients: Record<string, string>;
  /** When `true` (default), verify every claim's signature against `signers[chain].address`. */
  verifySignatures?: boolean;
  /**
   * Pre-loaded `mina-signer` `Client` (optional peer dep). REQUIRED to verify
   * `mina:*` claims when `verifySignatures` is on: `buildSettlementTx()` is
   * synchronous and `mina-signer` only loads via async `import()`, so the
   * caller must load it up front (see `loadMinaSignerClient()`) and inject it
   * here. When a `mina:*` claim is present and this is absent, that claim is
   * rejected with `MINA_VERIFICATION_UNSUPPORTED` rather than passed through
   * unverified. Ignored for EVM/Solana claims.
   */
  minaSignerClient?: MinaSignerClientLike;
  /** When `true`, include superseded claims in `result.superseded[]`. Default false. */
  includeSuperseded?: boolean;
  /** Optional pino-compatible logger. */
  logger?: {
    debug: (...a: unknown[]) => void;
    info: (...a: unknown[]) => void;
    warn: (...a: unknown[]) => void;
    error: (...a: unknown[]) => void;
  };
}

/**
 * Result of `buildSettlementTx()`.
 *
 * @stable — Epic 13 Chain Bridge DVM depends on this shape.
 * @since 12.6
 */
export interface BuildSettlementTxResult {
  /** One bundle per unique (chain, channelId) group that had at least one surviving claim. */
  bundles: SettlementBundle[];
  /** Claims rejected during signature verification. */
  rejected: {
    claim: AccumulatedClaim;
    reason:
      | 'SIGNATURE_INVALID'
      | 'SIGNER_MISMATCH'
      | 'MINA_VERIFICATION_UNSUPPORTED';
    details?: string;
  }[];
  /** Claims superseded by a higher-nonce claim in the same group (only populated if params.includeSuperseded). */
  superseded: AccumulatedClaim[];
}

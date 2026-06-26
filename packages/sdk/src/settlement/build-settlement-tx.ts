/**
 * `buildSettlementTx()` — public entrypoint for Story 12.6.
 *
 * Takes the output `claims` array from `streamSwap()` + per-chain signer
 * config + per-chain recipient addresses, and produces one
 * {@link SettlementBundle} per unique `(chain, channelId)` group.
 *
 * @module
 * @since 12.6
 * @see _bmad-output/implementation-artifacts/12-6-build-settlement-tx.md
 */

import { SettlementTxError } from '../errors.js';
import { base58Decode } from '../identity.js';
import type { AccumulatedClaim } from '../stream-swap.js';
import {
  buildEvmSettlementTx,
  recoverEvmSignerAddress,
  verifyEvmClaimSignature,
} from './evm.js';
import { buildMinaSettlementTx, verifyMinaSignature } from './mina.js';
import type { MinaSignerClientLike } from './mina.js';
import { buildSolanaSettlementTx, verifyEd25519Signature } from './solana.js';
import type {
  BuildSettlementTxParams,
  BuildSettlementTxResult,
  SwapSignerConfig,
  SettlementBundle,
} from './types.js';

const EVM_ADDRESS_REGEX = /^0x[0-9a-f]{40}$/;

function chainKindOf(chain: string): 'evm' | 'solana' | 'mina' | 'unknown' {
  if (chain.startsWith('evm:')) return 'evm';
  if (chain.startsWith('solana:')) return 'solana';
  if (chain.startsWith('mina:')) return 'mina';
  return 'unknown';
}

/**
 * Build raw unsigned settlement transactions from a bag of accumulated
 * swap claims.
 *
 * Algorithm:
 *   1. Validate params (synchronous throws on malformed input).
 *   2. Optionally verify each claim's signature. Rejected claims land in
 *      `result.rejected[]` and are dropped from further processing.
 *   3. Group surviving claims by `(chain, channelId)`. Within each group,
 *      assert recipient + swapSignerAddress consensus, unique nonces, and
 *      non-decreasing cumulativeAmount with nonce.
 *   4. Pick the winning claim per group (highest nonce).
 *   5. Dispatch each winner to its chain-specific tx builder.
 *
 * @stable
 * @since 12.6
 * @throws {SettlementTxError} Synchronously on malformed input, group-level
 *   inconsistency, or chain dispatch failures.
 *
 * @example
 * ```ts
 * const result = await streamSwap({ ... });
 * const { bundles } = buildSettlementTx({
 *   claims: result.claims,
 *   signers: {
 *     'evm:base:8453': {
 *       address: '0xswap...',
 *       contractAddress: '0xtokennetwork...',
 *       chainId: 8453,
 *     },
 *   },
 *   recipients: { 'evm:base:8453': '0xsender...' },
 * });
 * // Feed bundles[0].unsignedTxBytes into fillEvmSettlementTxGas → sign → eth_sendRawTransaction.
 * ```
 */
export function buildSettlementTx(
  params: BuildSettlementTxParams
): BuildSettlementTxResult {
  // ---- 1. Validate ----
  if (!Array.isArray(params.claims) || params.claims.length === 0) {
    throw new SettlementTxError(
      'INVALID_INPUT',
      'claims array is empty or not an array'
    );
  }
  if (!params.signers || typeof params.signers !== 'object') {
    throw new SettlementTxError('INVALID_INPUT', 'signers map is required');
  }
  if (!params.recipients || typeof params.recipients !== 'object') {
    throw new SettlementTxError('INVALID_INPUT', 'recipients map is required');
  }

  const logger = params.logger;
  const verifySignatures = params.verifySignatures ?? true;

  // Every claim must carry the five settlement-context fields.
  for (let i = 0; i < params.claims.length; i++) {
    const c = params.claims[i];
    if (c === undefined) continue; // bounded by loop — defensive for TS narrowing
    if (
      c.channelId === undefined ||
      c.nonce === undefined ||
      c.cumulativeAmount === undefined ||
      c.recipient === undefined ||
      c.swapSignerAddress === undefined
    ) {
      throw new SettlementTxError(
        'MISSING_SETTLEMENT_METADATA',
        `claims[${i}] missing one or more of { channelId, nonce, cumulativeAmount, recipient, swapSignerAddress }`
      );
    }
  }

  // Every distinct chain must have a signer + recipient + per-chain config validity.
  const distinctChains = new Set<string>();
  for (const c of params.claims) distinctChains.add(c.pair.to.chain);
  for (const chain of distinctChains) {
    const signer = params.signers[chain];
    if (!signer) {
      throw new SettlementTxError(
        'UNSUPPORTED_CHAIN',
        `signers map missing entry for chain ${chain}`
      );
    }
    if (!(chain in params.recipients)) {
      throw new SettlementTxError(
        'MISSING_RECIPIENT',
        `recipients map missing entry for chain ${chain}`
      );
    }
    const kind = chainKindOf(chain);
    if (kind === 'evm') {
      if (
        !signer.contractAddress ||
        !EVM_ADDRESS_REGEX.test(signer.contractAddress)
      ) {
        throw new SettlementTxError(
          'INVALID_INPUT',
          `EVM signers[${chain}].contractAddress must match 0x + 40 lowercase hex`
        );
      }
      if (
        typeof signer.chainId !== 'number' ||
        !Number.isInteger(signer.chainId) ||
        signer.chainId <= 0
      ) {
        throw new SettlementTxError(
          'INVALID_INPUT',
          `EVM signers[${chain}].chainId must be a positive integer`
        );
      }
    } else if (kind === 'solana') {
      if (!signer.programId || signer.programId.length === 0) {
        throw new SettlementTxError(
          'INVALID_INPUT',
          `Solana signers[${chain}].programId is required`
        );
      }
      // AC-4: programId MUST be a valid base58 string that decodes to 32 bytes.
      let programIdLen: number;
      try {
        programIdLen = base58Decode(signer.programId).length;
      } catch (err) {
        throw new SettlementTxError(
          'INVALID_INPUT',
          `Solana signers[${chain}].programId is not valid base58`,
          { cause: err }
        );
      }
      if (programIdLen !== 32) {
        throw new SettlementTxError(
          'INVALID_INPUT',
          `Solana signers[${chain}].programId must decode to 32 bytes (got ${programIdLen})`
        );
      }
    }
  }

  // ---- 2. Verify signatures (optional) ----
  const rejected: BuildSettlementTxResult['rejected'] = [];
  const survivors: AccumulatedClaim[] = [];
  for (const claim of params.claims) {
    if (!verifySignatures) {
      survivors.push(claim);
      continue;
    }
    const chain = claim.pair.to.chain;
    const signer = params.signers[chain];
    if (!signer) {
      // Already validated above; this branch is defensive for TS narrowing.
      throw new SettlementTxError(
        'UNSUPPORTED_CHAIN',
        `signers map missing entry for chain ${chain} (unreachable — validated)`
      );
    }
    const kind = chainKindOf(chain);
    if (kind === 'evm') {
      try {
        const { valid, recovered } = verifyEvmClaimSignature(
          claim,
          signer.address
        );
        if (!valid) {
          rejected.push({
            claim,
            reason: 'SIGNER_MISMATCH',
            details: `recovered=${recovered} expected=${signer.address.toLowerCase()}`,
          });
          continue;
        }
        survivors.push(claim);
      } catch (err) {
        rejected.push({
          claim,
          reason: 'SIGNATURE_INVALID',
          details: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (kind === 'solana') {
      try {
        const ok = verifyEd25519Signature(claim, signer.address);
        if (!ok) {
          rejected.push({
            claim,
            reason: 'SIGNER_MISMATCH',
            details: `ed25519.verify returned false against ${signer.address}`,
          });
          continue;
        }
        survivors.push(claim);
      } catch (err) {
        rejected.push({
          claim,
          reason: 'SIGNATURE_INVALID',
          details: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (kind === 'mina') {
      if (!params.minaSignerClient) {
        // mina-signer is an optional peer dep loaded via async import; the
        // sync pipeline cannot load it itself. Reject (rather than pass
        // through unverified) so an absent client never lets an unverified
        // Mina claim settle.
        rejected.push({
          claim,
          reason: 'MINA_VERIFICATION_UNSUPPORTED',
          details:
            'minaSignerClient not provided — load mina-signer via loadMinaSignerClient() and pass it in params.minaSignerClient to verify mina:* claims',
        });
        continue;
      }
      try {
        const ok = verifyMinaSignature(
          claim,
          signer.address,
          params.minaSignerClient
        );
        if (!ok) {
          rejected.push({
            claim,
            reason: 'SIGNER_MISMATCH',
            details: `mina-signer verifyFields returned false against ${signer.address}`,
          });
          continue;
        }
        survivors.push(claim);
      } catch (err) {
        rejected.push({
          claim,
          reason: 'SIGNATURE_INVALID',
          details: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      throw new SettlementTxError(
        'UNSUPPORTED_CHAIN',
        `Unknown chain kind for ${chain}`
      );
    }
  }

  logger?.debug?.({
    event: 'build_settlement_tx.verified',
    survivorCount: survivors.length,
    rejectedCount: rejected.length,
  });

  // ---- 3. Group by (chain, channelId) ----
  interface Group {
    chain: string;
    channelId: string;
    claims: { claim: AccumulatedClaim; originalIndex: number }[];
  }
  const groups = new Map<string, Group>();
  // Need the original input index for bundle.selectedClaimIndex.
  const originalIndex = new Map<AccumulatedClaim, number>();
  for (let i = 0; i < params.claims.length; i++) {
    const c = params.claims[i];
    if (c !== undefined) originalIndex.set(c, i);
  }
  for (const claim of survivors) {
    const chain = claim.pair.to.chain;
    const channelId = claim.channelId;
    if (channelId === undefined) {
      // Validated earlier — defensive branch.
      throw new SettlementTxError(
        'MISSING_SETTLEMENT_METADATA',
        'claim.channelId undefined after validation (unreachable)'
      );
    }
    const key = `${chain}::${channelId}`;
    let g = groups.get(key);
    if (!g) {
      g = { chain, channelId, claims: [] };
      groups.set(key, g);
    }
    const idx = originalIndex.get(claim);
    g.claims.push({ claim, originalIndex: idx ?? -1 });
  }

  // ---- 3b. Validate each group ----
  const superseded: AccumulatedClaim[] = [];
  const bundles: SettlementBundle[] = [];
  for (const g of groups.values()) {
    if (g.claims.length === 0) continue;
    const first = g.claims[0];
    if (!first) continue;
    const firstRecipient = first.claim.recipient;
    const firstSwapSigner = first.claim.swapSignerAddress;
    if (firstRecipient === undefined || firstSwapSigner === undefined) {
      throw new SettlementTxError(
        'MISSING_SETTLEMENT_METADATA',
        'winner claim missing recipient/swapSignerAddress (unreachable after validation)'
      );
    }
    for (let i = 1; i < g.claims.length; i++) {
      const entry = g.claims[i];
      if (!entry) continue;
      const c = entry.claim;
      if (c.recipient !== firstRecipient) {
        throw new SettlementTxError(
          'RECIPIENT_MISMATCH',
          `claims in channel ${g.channelId} disagree on recipient: ${firstRecipient} vs ${String(c.recipient)} (claim indices ${first.originalIndex}, ${entry.originalIndex})`
        );
      }
      if (c.swapSignerAddress !== firstSwapSigner) {
        throw new SettlementTxError(
          'SWAP_SIGNER_MISMATCH',
          `claims in channel ${g.channelId} disagree on swapSignerAddress: ${firstSwapSigner} vs ${String(c.swapSignerAddress)}`
        );
      }
    }
    // Nonces strictly unique within group.
    const nonceSeen = new Set<string>();
    for (const entry of g.claims) {
      const nonceStr = entry.claim.nonce;
      if (nonceStr === undefined) {
        throw new SettlementTxError(
          'MISSING_SETTLEMENT_METADATA',
          'claim.nonce undefined (unreachable after validation)'
        );
      }
      if (nonceSeen.has(nonceStr)) {
        throw new SettlementTxError(
          'DUPLICATE_NONCE',
          `channel ${g.channelId} has two claims with nonce ${nonceStr}`
        );
      }
      nonceSeen.add(nonceStr);
    }
    // Sort by nonce ascending, then enforce non-decreasing cumulativeAmount.
    const sorted = [...g.claims].sort((a, b) => {
      const an = BigInt(a.claim.nonce ?? '0');
      const bn = BigInt(b.claim.nonce ?? '0');
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    for (let i = 1; i < sorted.length; i++) {
      const prevE = sorted[i - 1];
      const currE = sorted[i];
      if (!prevE || !currE) continue;
      const prev = BigInt(prevE.claim.cumulativeAmount ?? '0');
      const curr = BigInt(currE.claim.cumulativeAmount ?? '0');
      if (curr < prev) {
        throw new SettlementTxError(
          'NON_MONOTONIC_CUMULATIVE',
          `channel ${g.channelId} nonce ${String(currE.claim.nonce)} has cumulativeAmount ${curr} < previous nonce ${String(prevE.claim.nonce)} cumulativeAmount ${prev}`
        );
      }
    }

    // Winner = highest nonce = last entry in sorted array.
    const winnerEntry = sorted[sorted.length - 1];
    if (!winnerEntry) continue;
    const winner = winnerEntry.claim;

    if (params.includeSuperseded) {
      for (let i = 0; i < sorted.length - 1; i++) {
        const e = sorted[i];
        if (e) superseded.push(e.claim);
      }
    }

    // Dispatch per chain kind.
    const signer = params.signers[g.chain];
    const recipient = params.recipients[g.chain];
    if (!signer || recipient === undefined) {
      throw new SettlementTxError(
        'UNSUPPORTED_CHAIN',
        `signers/recipients missing entry for ${g.chain} (unreachable after validation)`
      );
    }
    const kind = chainKindOf(g.chain);
    let bundle: SettlementBundle;
    if (kind === 'evm') {
      // Recipient address consistency check: bundle recipient MUST match
      // the claim's recipient. The recipients map is the sender's declared
      // address — any disagreement with the Swap-reported recipient signals
      // an adversarial Swap or caller misconfiguration.
      if (recipient.toLowerCase() !== firstRecipient.toLowerCase()) {
        throw new SettlementTxError(
          'RECIPIENT_MISMATCH',
          `recipients[${g.chain}] (${recipient}) does not match Swap-reported recipient (${firstRecipient})`
        );
      }
      bundle = buildEvmSettlementTx(
        winner,
        signer,
        recipient.toLowerCase(),
        winnerEntry.originalIndex,
        g.claims.length
      );
    } else if (kind === 'solana') {
      if (recipient !== firstRecipient) {
        throw new SettlementTxError(
          'RECIPIENT_MISMATCH',
          `recipients[${g.chain}] (${recipient}) does not match Swap-reported recipient (${firstRecipient})`
        );
      }
      bundle = buildSolanaSettlementTx(
        winner,
        signer,
        recipient,
        winnerEntry.originalIndex,
        g.claims.length
      );
    } else if (kind === 'mina') {
      // Mina addresses are case-sensitive base58 (no lowercasing, like Solana).
      if (recipient !== firstRecipient) {
        throw new SettlementTxError(
          'RECIPIENT_MISMATCH',
          `recipients[${g.chain}] (${recipient}) does not match Swap-reported recipient (${firstRecipient})`
        );
      }
      bundle = buildMinaSettlementTx(
        winner,
        signer,
        recipient,
        winnerEntry.originalIndex,
        g.claims.length
      );
    } else {
      throw new SettlementTxError(
        'UNSUPPORTED_CHAIN',
        `Unknown chain kind for ${g.chain}`
      );
    }
    bundles.push(bundle);
  }

  logger?.info?.({
    event: 'build_settlement_tx.complete',
    bundleCount: bundles.length,
    rejectedCount: rejected.length,
    supersededCount: superseded.length,
  });

  return { bundles, rejected, superseded };
}

/**
 * Standalone utility: verify a single `AccumulatedClaim`'s signature against
 * a `SwapSignerConfig` without running the full grouping/winner pipeline.
 *
 * Useful inside a `streamSwap()` `onPacket` callback for mid-stream claim
 * validation.
 *
 * For `mina:*` claims, pass a pre-loaded `mina-signer` `Client` as
 * `minaSignerClient` (see `loadMinaSignerClient()`); without it, Mina claims
 * return `MINA_VERIFICATION_UNSUPPORTED` (same contract as
 * `buildSettlementTx`).
 *
 * @stable
 * @since 12.6
 */
export function verifyAccumulatedClaim(
  claim: AccumulatedClaim,
  signer: SwapSignerConfig,
  minaSignerClient?: MinaSignerClientLike
): { valid: true } | { valid: false; reason: string } {
  const kind = chainKindOf(claim.pair.to.chain);
  if (kind === 'evm') {
    try {
      const { valid, recovered } = verifyEvmClaimSignature(
        claim,
        signer.address
      );
      if (valid) return { valid: true };
      return {
        valid: false,
        reason: `SIGNER_MISMATCH: recovered=${recovered} expected=${signer.address.toLowerCase()}`,
      };
    } catch (err) {
      return {
        valid: false,
        reason: `SIGNATURE_INVALID: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  if (kind === 'solana') {
    try {
      const ok = verifyEd25519Signature(claim, signer.address);
      return ok
        ? { valid: true }
        : {
            valid: false,
            reason: 'SIGNER_MISMATCH: ed25519.verify returned false',
          };
    } catch (err) {
      return {
        valid: false,
        reason: `SIGNATURE_INVALID: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  if (kind === 'mina') {
    if (!minaSignerClient) {
      return {
        valid: false,
        reason:
          'MINA_VERIFICATION_UNSUPPORTED: pass a mina-signer Client (loadMinaSignerClient()) as minaSignerClient to verify mina:* claims',
      };
    }
    try {
      const ok = verifyMinaSignature(claim, signer.address, minaSignerClient);
      return ok
        ? { valid: true }
        : {
            valid: false,
            reason: 'SIGNER_MISMATCH: mina-signer verifyFields returned false',
          };
    } catch (err) {
      return {
        valid: false,
        reason: `SIGNATURE_INVALID: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  return {
    valid: false,
    reason: `UNSUPPORTED_CHAIN: ${claim.pair.to.chain}`,
  };
}

// Re-export helper for tests + external callers that need address recovery
// without running the full pipeline.
export { recoverEvmSignerAddress };

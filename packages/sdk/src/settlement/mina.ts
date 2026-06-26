/**
 * Mina-specific settlement: balance-proof signature verification +
 * settlement-bundle construction (Story 12.8 follow-up to 12.6 AC-9).
 *
 * ## What is implemented (and unit-tested)
 *
 * - {@link verifyMinaSignature}: verifies the Swap's off-chain balance-proof
 *   signature using `mina-signer` (`verifyFields`). This is the EXACT inverse
 *   of the Swap's {@link MinaPaymentChannelSigner} (`packages/swap/src/payment-channel-signer.ts`),
 *   which signs `balanceProofFieldsMina(channelId, cumulativeAmount, nonce, recipient)`
 *   via `mina-signer`'s `signFields` and emits the base58 signature string as
 *   the claim's `claimBytes` (UTF-8). The field-element derivation lives in
 *   `hashes.ts` so signer and verifier cannot drift (same single-source-of-
 *   truth pattern as EVM/Solana).
 * - {@link buildMinaSettlementTx}: constructs a {@link SettlementBundle}
 *   envelope (chain metadata + the verified balance proof bytes) so a Chain
 *   Bridge DVM / direct sender has everything needed to drive the on-chain
 *   claim. The signature is re-emitted verbatim in `unsignedTxBytes`.
 *
 * ## What remains (documented gap — NOT silently stubbed)
 *
 * The final on-chain step — submitting a Mina zkApp `claimFromChannel`
 * transaction that settles the channel — requires **o1js circuit compilation
 * + zk-SNARK proof generation** (Poseidon balance-commitment, zkApp method
 * proving). The connector already implements this in
 * `MinaPaymentChannelSDK.claimFromChannel()` (o1js, heavyweight). That proof
 * generation is intentionally NOT done here: o1js circuit compilation is far
 * too heavy for a unit-testable SDK helper and would pull a multi-hundred-MB
 * WASM dependency into every SDK consumer. Instead, the bundle carries the
 * verified balance proof so a Mina-capable settler (the connector's
 * `MinaPaymentChannelProvider`, or a future o1js-backed Chain Bridge DVM) can
 * generate the proof + broadcast. See the on-chain settlement note below
 * (connector 3.8.1 wires the dual-party claim path — connector#84).
 *
 * Note also: the Swap↔sender wire proof here (a Schnorr signature over four
 * field elements) is a DIFFERENT object than the connector's on-chain
 * `MinaPaymentChannelSDK` Poseidon-commitment proof shape
 * (`{ commitment, signature, nonce }`). The verifier matches the Swap's
 * actual emitted format (`MinaPaymentChannelSigner`), which is what a sender
 * receives on-wire.
 *
 * @module
 * @since 12.8
 */

import { SettlementTxError } from '../errors.js';
import type { AccumulatedClaim } from '../stream-swap.js';
import { balanceProofFieldsMina } from './hashes.js';
import type { SwapSignerConfig, SettlementBundle } from './types.js';

/**
 * Network id the Swap signs with (`MinaPaymentChannelSigner` uses
 * `network: 'mainnet'`). The signature itself is network-agnostic for the
 * `signFields`/`verifyFields` path — `mina-signer` only folds the network id
 * into message-string hashing, not pre-hashed field arrays — but we keep this
 * aligned with the Swap for clarity and future-proofing.
 */
const MINA_NETWORK = 'mainnet';

/**
 * Minimal structural type for the slice of the `mina-signer` `Client` we use.
 * Declared locally so the SDK does not hard-depend on the optional peer dep's
 * full type surface (the ambient `mina-signer.d.ts` only declares
 * `derivePublicKey`). `verifyFields` is synchronous.
 */
export interface MinaSignerClientLike {
  verifyFields(input: {
    data: bigint[];
    signature: string;
    publicKey: string;
  }): boolean;
}

/**
 * Constructor shape of the `mina-signer` default export.
 */
type MinaSignerClientCtor = new (opts: {
  network: string;
}) => MinaSignerClientLike;

/**
 * Lazily load `mina-signer` (optional peer dep) and instantiate a `Client`
 * bound to {@link MINA_NETWORK}. Returns `undefined` when the peer dep is not
 * installed — callers MUST treat that as "cannot verify Mina claims" rather
 * than "claim is valid".
 *
 * Mirrors the dynamic-import pattern in `identity.ts` (`deriveMinaIdentity`).
 *
 * @since 12.8
 */
export async function loadMinaSignerClient(): Promise<
  MinaSignerClientLike | undefined
> {
  try {
    // `mina-signer` is an optional peer dep — dynamic import so the SDK
    // type-checks and runs without it installed.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lib: any = await import('mina-signer');
    const Ctor: MinaSignerClientCtor = 'default' in lib ? lib.default : lib;
    return new Ctor({ network: MINA_NETWORK });
  } catch {
    return undefined;
  }
}

/**
 * Verify a Mina balance-proof Schnorr signature carried in an
 * `AccumulatedClaim`.
 *
 * Re-derives the signed field-element message via {@link balanceProofFieldsMina}
 * (identical to the Swap signer), decodes the claim's `claimBytes` to the
 * base58 signature string the Swap emitted, and verifies it against
 * `expectedSignerAddress` using a `mina-signer` `Client`.
 *
 * `client` MUST be a pre-loaded `mina-signer` `Client` (see
 * {@link loadMinaSignerClient}). It is injected (rather than imported inline)
 * so the synchronous `buildSettlementTx()` pipeline can verify Mina claims
 * without becoming async.
 *
 * @returns `true` iff the signature is valid for the given signer address.
 * @throws {SettlementTxError} on missing settlement metadata or a malformed
 *   (non-UTF-8 / empty) signature payload.
 * @since 12.8
 */
export function verifyMinaSignature(
  claim: AccumulatedClaim,
  expectedSignerAddress: string,
  client: MinaSignerClientLike
): boolean {
  if (
    claim.channelId === undefined ||
    claim.cumulativeAmount === undefined ||
    claim.nonce === undefined ||
    claim.recipient === undefined
  ) {
    throw new SettlementTxError(
      'MISSING_SETTLEMENT_METADATA',
      'Claim missing channelId/cumulativeAmount/nonce/recipient for Mina signature verify'
    );
  }
  if (claim.claimBytes.length === 0) {
    throw new SettlementTxError(
      'INVALID_SIGNATURE_LENGTH',
      'Mina claimBytes is empty (expected UTF-8 base58 signature string)'
    );
  }

  // The Swap emits the `mina-signer` base58 signature string as UTF-8 bytes.
  const signature = new TextDecoder().decode(claim.claimBytes);

  const fields = balanceProofFieldsMina(
    claim.channelId,
    BigInt(claim.cumulativeAmount),
    BigInt(claim.nonce),
    claim.recipient
  );

  try {
    return client.verifyFields({
      data: fields,
      signature,
      publicKey: expectedSignerAddress,
    });
  } catch {
    // `verifyFields` throws on a structurally invalid signature / publicKey.
    // Treat that as "not valid" rather than crashing the settlement pipeline.
    return false;
  }
}

/**
 * Discriminator for the Mina on-chain `claimFromChannel` zkApp method.
 *
 * On-chain settlement: the actual transaction is a Mina zkApp method call
 * requiring o1js circuit compilation + zk-SNARK proof generation. As of
 * `@toon-protocol/connector` 3.8.1 the connector's settlement executor wires
 * the dual-party `MinaPaymentChannelSDK.claimFromChannel()` path with the real
 * counterparty balance, salt, and both party signatures (connector#84 — earlier
 * builds passed single-sig/zeroed placeholders that left Mina claims
 * un-settleable). Proof generation + broadcast remain the connector-side
 * settler's responsibility and are intentionally out of scope for this SDK
 * helper — see the module docblock. The bundle below therefore carries the
 * verified balance-proof bytes + channel metadata for that settler to consume.
 */

/**
 * Build a Mina {@link SettlementBundle} from a winning `AccumulatedClaim`.
 *
 * Unlike the EVM/Solana builders (which produce a chain-native unsigned tx),
 * this builder produces a settlement ENVELOPE: it validates the winning
 * claim's settlement context and re-emits the Swap's verified balance-proof
 * signature bytes in `unsignedTxBytes`. The actual on-chain `claimFromChannel`
 * zkApp transaction (o1js proof generation) is the responsibility of a
 * Mina-capable settler — see the module docblock + the on-chain settlement note.
 *
 * The signature carried here is the SAME `claimBytes` the sender already
 * verified via {@link verifyMinaSignature}, so a downstream settler does not
 * need to re-derive it.
 *
 * @since 12.8
 */
export function buildMinaSettlementTx(
  winner: AccumulatedClaim,
  signer: SwapSignerConfig,
  recipient: string,
  selectedClaimIndex: number,
  claimsMerged: number
): SettlementBundle {
  if (
    winner.channelId === undefined ||
    winner.cumulativeAmount === undefined ||
    winner.nonce === undefined ||
    winner.recipient === undefined ||
    winner.swapSignerAddress === undefined
  ) {
    throw new SettlementTxError(
      'MISSING_SETTLEMENT_METADATA',
      'Mina winner claim missing settlement-context fields'
    );
  }
  if (!signer.address) {
    throw new SettlementTxError(
      'INVALID_INPUT',
      `Mina SwapSignerConfig.address is required for chain ${winner.pair.to.chain}`
    );
  }
  if (winner.claimBytes.length === 0) {
    throw new SettlementTxError(
      'INVALID_SIGNATURE_LENGTH',
      'Mina winner claimBytes is empty (expected UTF-8 base58 signature string)'
    );
  }

  // Envelope: the verified balance-proof signature bytes. A Mina-capable
  // settler generates the o1js claimFromChannel proof from (channelId,
  // cumulativeAmount, nonce, recipient, signature) — connector 3.8.1, #84.
  const unsignedTxBytes = winner.claimBytes;

  return {
    chain: winner.pair.to.chain,
    chainKind: 'mina',
    channelId: winner.channelId,
    cumulativeAmount: winner.cumulativeAmount,
    nonce: winner.nonce,
    recipient,
    swapSignerAddress: winner.swapSignerAddress,
    unsignedTxBytes,
    claimsMerged,
    selectedClaimIndex,
    sourceChain: winner.pair.from.chain,
    sourceAssetCode: winner.pair.from.assetCode,
  };
}

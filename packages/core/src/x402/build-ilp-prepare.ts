/**
 * Shared ILP PREPARE packet construction for the TOON protocol.
 *
 * This function is the **single point of truth** for constructing ILP PREPARE
 * packet parameters. Both the x402 `/publish` handler and the existing
 * `publishEvent()` in the SDK must use it (or produce equivalent output).
 *
 * This ensures packet equivalence: the destination relay cannot distinguish
 * between packets sent via the x402 HTTP on-ramp and the ILP-native rail.
 *
 * @module
 */

/**
 * Parameters for constructing an ILP PREPARE packet.
 */
export interface BuildIlpPrepareParams {
  /** ILP destination address (e.g., "g.toon.target-relay"). */
  destination: string;
  /** Payment amount in ILP units (bigint). */
  amount: bigint;
  /** TOON-encoded event as raw bytes. */
  data: Uint8Array;
  /**
   * Per-packet expiry. When provided, it is propagated onto the produced
   * PREPARE (as an ISO 8601 string) so the transport sets exactly this
   * expiry on the wire. When omitted, the transport applies its own
   * default (typically derived from the request timeout, ~30s).
   */
  expiresAt?: Date;
}

/**
 * Result of building an ILP PREPARE packet.
 *
 * This matches the shape expected by `IlpClient.sendIlpPacket()`:
 * `{ destination, amount, data }` where amount is a string and data
 * is base64-encoded.
 */
export interface IlpPreparePacket {
  /** ILP destination address. */
  destination: string;
  /** Payment amount as a string (BigInt.toString()). */
  amount: string;
  /** TOON-encoded event as base64 string. */
  data: string;
  /**
   * Packet expiry as an ISO 8601 string. Present only when the caller
   * supplied `expiresAt`; absent means the transport picks its default
   * (timeout-derived). Matches the connector's `POST /admin/ilp/send`
   * request field.
   */
  expiresAt?: string;
}

/**
 * Build an ILP PREPARE packet from the given parameters.
 *
 * Converts the bigint amount to a string, encodes the TOON data to base64,
 * passes through the destination, and — when supplied — serializes the
 * per-packet expiry to ISO 8601. This is deliberately simple -- the
 * value is in having ONE function both the x402 and ILP paths call, not
 * in complex logic.
 *
 * @param params - Packet construction parameters.
 * @returns ILP PREPARE packet fields ready for `sendIlpPacket()`.
 */
export function buildIlpPrepare(
  params: BuildIlpPrepareParams
): IlpPreparePacket {
  return {
    destination: params.destination,
    amount: String(params.amount),
    data: Buffer.from(params.data).toString('base64'),
    ...(params.expiresAt !== undefined && {
      expiresAt: params.expiresAt.toISOString(),
    }),
  };
}

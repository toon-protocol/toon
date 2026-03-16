/**
 * Shared ILP PREPARE packet construction for the Crosstown protocol.
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
  /** ILP destination address (e.g., "g.crosstown.target-relay"). */
  destination: string;
  /** Payment amount in ILP units (bigint). */
  amount: bigint;
  /** TOON-encoded event as raw bytes. */
  data: Uint8Array;
  /** Packet expiry. Default: 30 seconds from now. */
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
}

/**
 * Build an ILP PREPARE packet from the given parameters.
 *
 * Converts the bigint amount to a string, encodes the TOON data to base64,
 * and passes through the destination. This is deliberately simple -- the
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
  };
}

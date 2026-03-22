/**
 * Pure function for calculating ILP PREPARE amount including intermediary routing fees.
 *
 * Formula: totalAmount = basePricePerByte * packetBytes + SUM(hopFees[i] * packetBytes)
 *
 * All arithmetic uses bigint -- no floating point, no overflow risk.
 */

/**
 * Parameters for route-aware fee calculation.
 */
export interface CalculateRouteAmountParams {
  /** Base price per byte charged by the destination node. */
  basePricePerByte: bigint;
  /** Length of the TOON-encoded packet in bytes. */
  packetByteLength: number;
  /** Per-byte fees for each intermediary hop on the route (ordered sender-to-destination). */
  hopFees: bigint[];
}

/**
 * Calculates the total ILP PREPARE amount including intermediary routing fees.
 *
 * For a direct route (empty hopFees), returns basePricePerByte * packetByteLength.
 * For multi-hop routes, adds each intermediary's feePerByte * packetByteLength.
 *
 * @returns Total amount as bigint.
 */
export function calculateRouteAmount(
  params: CalculateRouteAmountParams
): bigint {
  const { basePricePerByte, packetByteLength, hopFees } = params;

  // Guard against negative byte length (public API defense)
  if (packetByteLength < 0) {
    return 0n;
  }

  const bytes = BigInt(packetByteLength);

  const baseAmount = basePricePerByte * bytes;
  const intermediaryFees = hopFees.reduce((sum, fee) => sum + fee * bytes, 0n);

  return baseAmount + intermediaryFees;
}

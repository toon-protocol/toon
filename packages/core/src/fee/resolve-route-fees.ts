/**
 * Resolves intermediary routing fees from discovered peers using LCA-based
 * route resolution on the ILP address tree.
 *
 * Algorithm:
 * 1. Split sender and destination ILP addresses into segments.
 * 2. Find the longest common ancestor (LCA) -- shared prefix of segments.
 * 3. Intermediaries are the segments on the path from LCA down to destination's parent.
 * 4. For each intermediary, look up feePerByte from discovered peers.
 * 5. Unknown intermediaries default to feePerByte 0n with a warning.
 */

import type { DiscoveredPeer } from '../bootstrap/types.js';

/**
 * Parameters for resolving route fees.
 */
export interface ResolveRouteFeesParams {
  /** ILP address of the destination node. */
  destination: string;
  /** ILP address of the sender (own node). */
  ownIlpAddress: string;
  /** All discovered peers (including peered ones) with their ILP peer info. */
  discoveredPeers: DiscoveredPeer[];
}

/**
 * Result of route fee resolution.
 */
export interface ResolveRouteFeesResult {
  /** Per-byte fees for each intermediary hop, ordered sender-to-destination. */
  hopFees: bigint[];
  /** Warning messages for unknown intermediaries that defaulted to 0. */
  warnings: string[];
}

/**
 * Resolves intermediary routing fees for a route from sender to destination.
 *
 * Uses LCA-based route resolution: intermediary hops are the ILP address
 * segments between the longest common ancestor and the destination's parent.
 *
 * @returns Hop fees and any warnings about unknown intermediaries.
 */
export function resolveRouteFees(
  params: ResolveRouteFeesParams
): ResolveRouteFeesResult {
  const { destination, ownIlpAddress, discoveredPeers } = params;

  // Guard against empty or whitespace-only addresses
  if (
    !destination ||
    !destination.trim() ||
    !ownIlpAddress ||
    !ownIlpAddress.trim()
  ) {
    return { hopFees: [], warnings: [] };
  }

  const senderSegments = ownIlpAddress.split('.');
  const destSegments = destination.split('.');

  // Find longest common ancestor (LCA)
  let lcaLength = 0;
  const minLength = Math.min(senderSegments.length, destSegments.length);
  for (let i = 0; i < minLength; i++) {
    if (senderSegments[i] === destSegments[i]) {
      lcaLength = i + 1;
    } else {
      break;
    }
  }

  // Intermediaries are segments from LCA+1 to destination's parent (exclusive of final segment).
  // Example: LCA = g.toon (length 2), dest = g.toon.euwest.relay42 (length 4)
  //   -> intermediary prefixes: g.toon.euwest (segments 0..2, i.e., index 2)
  const intermediaryPrefixes: string[] = [];
  for (let i = lcaLength; i < destSegments.length - 1; i++) {
    const prefix = destSegments.slice(0, i + 1).join('.');
    intermediaryPrefixes.push(prefix);
  }

  // If no intermediaries (direct route), return empty
  if (intermediaryPrefixes.length === 0) {
    return { hopFees: [], warnings: [] };
  }

  // Build ILP-address-keyed lookup from discovered peers for O(1) matching.
  // A peer can match by its primary ilpAddress or any entry in ilpAddresses.
  const peerByAddress = new Map<string, DiscoveredPeer>();
  for (const peer of discoveredPeers) {
    peerByAddress.set(peer.peerInfo.ilpAddress, peer);
    if (peer.peerInfo.ilpAddresses) {
      for (const addr of peer.peerInfo.ilpAddresses) {
        peerByAddress.set(addr, peer);
      }
    }
  }

  // Resolve fees for each intermediary
  const hopFees: bigint[] = [];
  const warnings: string[] = [];

  for (const prefix of intermediaryPrefixes) {
    const peer = peerByAddress.get(prefix);
    if (peer) {
      let fee: bigint;
      try {
        fee = BigInt(peer.peerInfo.feePerByte ?? '0');
      } catch {
        // Malformed feePerByte (non-numeric string) -- treat as 0
        fee = 0n;
        warnings.push(
          `Invalid feePerByte "${peer.peerInfo.feePerByte}" at ${prefix}: defaulting to 0`
        );
      }
      // Guard against malicious negative feePerByte from kind:10032 events
      hopFees.push(fee < 0n ? 0n : fee);
    } else {
      hopFees.push(0n);
      warnings.push(
        `Unknown intermediary at ${prefix}: defaulting feePerByte to 0`
      );
    }
  }

  return { hopFees, warnings };
}

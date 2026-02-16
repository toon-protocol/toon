/**
 * Pure functions for settlement chain negotiation.
 * No I/O or side effects — used by NostrSpspServer to determine
 * the best matching settlement chain and token for a peering handshake.
 */

/**
 * Negotiates the best matching settlement chain between requester and responder.
 *
 * Preference order:
 * 1. Chain in intersection with requester's preferred token
 * 2. Chain in intersection with responder's preferred token
 * 3. First chain in intersection (requester's order preserved)
 *
 * @param requesterChains - Chain identifiers the requester supports
 * @param responderChains - Chain identifiers the responder supports
 * @param requesterPreferredTokens - Requester's preferred tokens by chain
 * @param responderPreferredTokens - Responder's preferred tokens by chain
 * @returns The negotiated chain identifier, or null if no intersection
 */
export function negotiateSettlementChain(
  requesterChains: string[],
  responderChains: string[],
  requesterPreferredTokens?: Record<string, string>,
  responderPreferredTokens?: Record<string, string>
): string | null {
  // Compute intersection preserving requester's order
  const responderSet = new Set(responderChains);
  const intersection = requesterChains.filter((chain) => responderSet.has(chain));

  if (intersection.length === 0) {
    return null;
  }

  // Prefer chain with requester's preferred token
  if (requesterPreferredTokens) {
    const requesterMatch = intersection.find(
      (chain) => requesterPreferredTokens[chain] !== undefined
    );
    if (requesterMatch) {
      return requesterMatch;
    }
  }

  // Prefer chain with responder's preferred token
  if (responderPreferredTokens) {
    const responderMatch = intersection.find(
      (chain) => responderPreferredTokens[chain] !== undefined
    );
    if (responderMatch) {
      return responderMatch;
    }
  }

  // Fall back to first intersection match (length > 0 guaranteed by check above)
  return intersection[0] ?? null;
}

/**
 * Resolves which token to use for a given chain.
 *
 * Priority: requester's preference > responder's preference > undefined
 *
 * @param chain - The chain identifier to resolve token for
 * @param requesterPreferredTokens - Requester's preferred tokens by chain
 * @param responderPreferredTokens - Responder's preferred tokens by chain
 * @returns The token address, or undefined if neither party has a preference
 */
export function resolveTokenForChain(
  chain: string,
  requesterPreferredTokens?: Record<string, string>,
  responderPreferredTokens?: Record<string, string>
): string | undefined {
  if (requesterPreferredTokens?.[chain] !== undefined) {
    return requesterPreferredTokens[chain];
  }
  if (responderPreferredTokens?.[chain] !== undefined) {
    return responderPreferredTokens[chain];
  }
  return undefined;
}

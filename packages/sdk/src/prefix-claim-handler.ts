/**
 * Prefix claim handler for the TOON prefix marketplace.
 *
 * Creates a handler that processes kind 10034 prefix claim events,
 * validates payment and prefix availability, and publishes grant
 * confirmations. Lives in SDK (not core) because it depends on
 * the SDK's Handler type and HandlerContext interface.
 */

import type { NostrEvent } from 'nostr-tools/pure';
import {
  parsePrefixClaimEvent,
  buildPrefixGrantEvent,
  validatePrefix,
} from '@toon-protocol/core';
import type { Handler, HandlerResponse } from './handler-registry.js';
import type { HandlerContext } from './handler-context.js';

/**
 * Options for creating a prefix claim handler.
 */
export interface PrefixClaimHandlerOptions {
  /** Pricing configuration for prefix claims. */
  prefixPricing: { basePrice: bigint };
  /** Secret key for signing grant events. */
  secretKey: Uint8Array;
  /** Returns the current map of claimed prefixes (prefix -> claimer pubkey). */
  getClaimedPrefixes: () => Map<string, string>;
  /**
   * Atomically claim a prefix for a pubkey. Returns true if the claim
   * succeeded, false if the prefix was already taken. This is the
   * serialization point for race condition defense.
   */
  claimPrefix: (prefix: string, claimerPubkey: string) => boolean;
  /** Publish the grant event (e.g., to the local relay). */
  publishGrant: (grantEvent: NostrEvent) => Promise<void>;
  /** ILP address prefix to include in the grant event (default: 'g.toon'). */
  ilpAddressPrefix?: string;
}

/**
 * Creates a handler for kind 10034 prefix claim events.
 *
 * The handler validates payment, prefix availability, and prefix format,
 * then atomically claims the prefix and publishes a grant confirmation.
 *
 * @param options - Handler configuration
 * @returns A Handler function for kind 10034 events
 */
export function createPrefixClaimHandler(
  options: PrefixClaimHandlerOptions
): Handler {
  return async (ctx: HandlerContext): Promise<HandlerResponse> => {
    // 1. Parse the incoming event as PrefixClaimContent
    const event = ctx.decode();
    const claim = parsePrefixClaimEvent(event);
    if (!claim) {
      return ctx.reject('F06', 'Invalid prefix claim event: malformed content');
    }

    // 2. Validate the prefix format
    const validation = validatePrefix(claim.requestedPrefix);
    if (!validation.valid) {
      return ctx.reject(
        'F06',
        `Invalid prefix: ${validation.reason ?? 'unknown validation error'}`
      );
    }

    // 3. Check payment is sufficient
    if (ctx.amount < options.prefixPricing.basePrice) {
      return ctx.reject(
        'F06',
        `Insufficient payment: received ${ctx.amount}, required ${options.prefixPricing.basePrice}`
      );
    }

    // 4. Check prefix availability
    const claimedPrefixes = options.getClaimedPrefixes();
    if (claimedPrefixes.has(claim.requestedPrefix)) {
      return ctx.reject(
        'F06',
        `PREFIX_TAKEN: prefix "${claim.requestedPrefix}" is already claimed`
      );
    }

    // 5. Atomically claim the prefix (serialization point for race conditions)
    const claimed = options.claimPrefix(claim.requestedPrefix, event.pubkey);
    if (!claimed) {
      return ctx.reject(
        'F06',
        `PREFIX_TAKEN: prefix "${claim.requestedPrefix}" is already claimed`
      );
    }

    // 6. Build and publish grant event
    const prefix = options.ilpAddressPrefix ?? 'g.toon';
    const ilpAddress = `${prefix}.${claim.requestedPrefix}`;
    const grantEvent = buildPrefixGrantEvent(
      {
        grantedPrefix: claim.requestedPrefix,
        claimerPubkey: event.pubkey,
        ilpAddress,
      },
      options.secretKey
    );
    await options.publishGrant(grantEvent);

    // 7. Accept the ILP packet
    return ctx.accept();
  };
}

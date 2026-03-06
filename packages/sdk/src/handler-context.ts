/**
 * Handler context for @crosstown/sdk.
 *
 * Provides a context object passed to kind-based handlers with methods
 * for accessing TOON data, shallow-parsed metadata, and accept/reject actions.
 */

import type { NostrEvent } from 'nostr-tools/pure';
import type { ToonRoutingMeta } from '@crosstown/core/toon';
import type {
  HandlePacketAcceptResponse,
  HandlePacketRejectResponse,
} from '@crosstown/core';

// Re-export core response types so SDK consumers don't need to import from core
export type { HandlePacketAcceptResponse, HandlePacketRejectResponse };

/**
 * The handler context passed to each kind-based handler.
 */
export interface HandlerContext {
  /** Raw TOON string (base64-encoded). */
  readonly toon: string;
  /** Event kind from shallow parse. */
  readonly kind: number;
  /** Event pubkey from shallow parse. */
  readonly pubkey: string;
  /** Payment amount in the ILP packet. */
  readonly amount: bigint;
  /** ILP destination address. */
  readonly destination: string;
  /** Lazy-decode the TOON payload into a full NostrEvent. */
  decode(): NostrEvent;
  /** Accept the packet with optional metadata. */
  accept(metadata?: Record<string, unknown>): HandlePacketAcceptResponse;
  /** Reject the packet with an ILP error code and message. */
  reject(code: string, message: string): HandlePacketRejectResponse;
}

export interface CreateHandlerContextOptions {
  toon: string;
  meta: ToonRoutingMeta;
  amount: bigint;
  destination: string;
  toonDecoder: (toon: string) => NostrEvent;
}

/**
 * Creates a HandlerContext from the given options.
 */
export function createHandlerContext(
  options: CreateHandlerContextOptions
): HandlerContext {
  let cachedEvent: NostrEvent | undefined;

  return {
    get toon() {
      return options.toon;
    },
    get kind() {
      return options.meta.kind;
    },
    get pubkey() {
      return options.meta.pubkey;
    },
    get amount() {
      return options.amount;
    },
    get destination() {
      return options.destination;
    },
    decode(): NostrEvent {
      if (!cachedEvent) {
        cachedEvent = options.toonDecoder(options.toon);
      }
      return cachedEvent;
    },
    accept(metadata?: Record<string, unknown>): HandlePacketAcceptResponse {
      // Placeholder fulfillment for SDK handler context. In production, the BLS
      // computes the real fulfillment as SHA-256(eventId). SDK users building
      // custom handlers should override this with a cryptographically valid value.
      return {
        accept: true,
        fulfillment: 'default-fulfillment',
        ...(metadata ? { metadata } : {}),
      };
    },
    reject(code: string, message: string): HandlePacketRejectResponse {
      return {
        accept: false,
        code,
        message,
      };
    },
  };
}

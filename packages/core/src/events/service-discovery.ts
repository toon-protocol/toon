/**
 * Event builder and parser for kind:10035 Service Discovery events.
 *
 * Kind 10035 is a NIP-16 replaceable event (kind 10000-19999) published to
 * the local relay and optionally to peers. Relays store only the latest event
 * per `pubkey + kind`. The `d` tag with value `crosstown-service-discovery` is
 * included as a content marker for filtering.
 *
 * Service discovery events advertise a node's capabilities, pricing, and
 * endpoints so that clients and AI agents can programmatically discover
 * available services.
 */

import { finalizeEvent } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import { SERVICE_DISCOVERY_KIND } from '../constants.js';

// Re-export the constant for convenient co-located imports
export { SERVICE_DISCOVERY_KIND };

// ---------- Types ----------

/** Content payload for a kind:10035 Service Discovery event. */
export interface ServiceDiscoveryContent {
  /** Service type identifier (e.g., 'relay', 'rig'). */
  serviceType: string;
  /** ILP address of the node's connector. */
  ilpAddress: string;
  /** Pricing configuration. */
  pricing: {
    /** Base price per byte in smallest token unit. */
    basePricePerByte: number;
    /** Payment token symbol (e.g., 'USDC'). */
    currency: string;
  };
  /**
   * x402 endpoint configuration.
   * Omitted entirely when x402 is disabled (not set to `{ enabled: false }`).
   */
  x402?: {
    /** Whether x402 is enabled. */
    enabled: boolean;
    /** HTTP endpoint path (e.g., '/publish'). */
    endpoint?: string;
  };
  /** Nostr event kinds this node accepts for storage. */
  supportedKinds: number[];
  /** Capabilities advertised by this node (e.g., ['relay', 'x402']). */
  capabilities: string[];
  /** Chain preset name (e.g., 'anvil', 'arbitrum-one'). */
  chain: string;
  /** Node software version. */
  version: string;
}

// ---------- Builder ----------

/**
 * Builds a kind:10035 Service Discovery event (NIP-16 replaceable).
 * Kind 10035 is in the 10000-19999 replaceable range (NIP-16).
 * Relays store only the latest event per pubkey + kind.
 * Includes 'd' tag with value 'crosstown-service-discovery' as a content marker.
 *
 * @param content - The service discovery payload.
 * @param secretKey - The secret key to sign the event with.
 * @returns A signed Nostr event.
 */
export function buildServiceDiscoveryEvent(
  content: ServiceDiscoveryContent,
  secretKey: Uint8Array
): NostrEvent {
  return finalizeEvent(
    {
      kind: SERVICE_DISCOVERY_KIND,
      content: JSON.stringify(content),
      tags: [['d', 'crosstown-service-discovery']],
      created_at: Math.floor(Date.now() / 1000),
    },
    secretKey
  );
}

// ---------- Parser ----------

/**
 * Parses a kind:10035 event content into ServiceDiscoveryContent.
 * Validates required fields. Returns null for malformed content.
 *
 * @param event - The Nostr event to parse.
 * @returns The parsed content, or null if invalid.
 */
export function parseServiceDiscovery(
  event: NostrEvent
): ServiceDiscoveryContent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.content);
  } catch {
    return null;
  }

  // Must be a non-null object (not an array)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;

  // Validate required string fields
  const serviceType = record['serviceType'];
  if (typeof serviceType !== 'string') return null;

  const ilpAddress = record['ilpAddress'];
  if (typeof ilpAddress !== 'string') return null;

  const chain = record['chain'];
  if (typeof chain !== 'string') return null;

  const version = record['version'];
  if (typeof version !== 'string') return null;

  // Validate pricing object (must be a plain object, not an array)
  const pricing = record['pricing'];
  if (typeof pricing !== 'object' || pricing === null || Array.isArray(pricing))
    return null;
  const pricingRecord = pricing as Record<string, unknown>;

  const basePricePerByte = pricingRecord['basePricePerByte'];
  if (typeof basePricePerByte !== 'number') return null;
  if (!isFinite(basePricePerByte) || basePricePerByte < 0) return null;

  const currency = pricingRecord['currency'];
  if (typeof currency !== 'string') return null;

  // Validate supportedKinds array
  const supportedKinds = record['supportedKinds'];
  if (!Array.isArray(supportedKinds)) return null;
  // Ensure all elements are finite non-negative integers (valid Nostr event kinds)
  if (
    !supportedKinds.every(
      (k): k is number => typeof k === 'number' && Number.isInteger(k) && k >= 0
    )
  ) {
    return null;
  }

  // Validate capabilities array
  const capabilities = record['capabilities'];
  if (!Array.isArray(capabilities)) return null;
  if (!capabilities.every((c): c is string => typeof c === 'string')) {
    return null;
  }

  // Build result
  const result: ServiceDiscoveryContent = {
    serviceType,
    ilpAddress,
    pricing: { basePricePerByte, currency },
    supportedKinds,
    capabilities,
    chain,
    version,
  };

  // Validate optional x402 field
  const x402 = record['x402'];
  if (x402 !== undefined) {
    if (typeof x402 !== 'object' || x402 === null || Array.isArray(x402))
      return null;
    const x402Record = x402 as Record<string, unknown>;

    const enabled = x402Record['enabled'];
    if (typeof enabled !== 'boolean') return null;

    const x402Result: ServiceDiscoveryContent['x402'] = { enabled };

    const endpoint = x402Record['endpoint'];
    if (endpoint !== undefined) {
      if (typeof endpoint !== 'string') return null;
      x402Result.endpoint = endpoint;
    }

    result.x402 = x402Result;
  }

  return result;
}

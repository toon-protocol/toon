/**
 * Parsers for ILP-related Nostr events.
 */

import type { NostrEvent } from 'nostr-tools/pure';
import { ILP_PEER_INFO_KIND } from '../constants.js';
import { InvalidEventError } from '../errors.js';
import { isValidIlpAddressStructure } from '../address/ilp-address-validation.js';
import type { IlpPeerInfo } from '../types.js';

/**
 * Validates a chain identifier string.
 * Valid format: {blockchain}:{network} or {blockchain}:{network}:{chainId}
 * Minimum 2 segments, maximum 3, separated by `:`. All segments must be non-empty.
 *
 * @param chainId - The chain identifier to validate
 * @returns true if the chain identifier is valid
 */
export function validateChainId(chainId: string): boolean {
  if (!chainId) return false;
  const segments = chainId.split(':');
  if (segments.length < 2 || segments.length > 3) return false;
  return segments.every((s) => s.length > 0);
}

/**
 * Type guard to check if a value is a non-null object.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Parses a kind:10032 Nostr event into an IlpPeerInfo object.
 *
 * @param event - The Nostr event to parse
 * @returns The parsed IlpPeerInfo object
 * @throws InvalidEventError if the event is malformed or missing required fields
 */
export function parseIlpPeerInfo(event: NostrEvent): IlpPeerInfo {
  if (event.kind !== ILP_PEER_INFO_KIND) {
    throw new InvalidEventError(
      `Expected event kind ${ILP_PEER_INFO_KIND}, got ${event.kind}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(event.content);
  } catch (err) {
    throw new InvalidEventError(
      'Failed to parse event content as JSON',
      err instanceof Error ? err : undefined
    );
  }

  if (!isObject(parsed)) {
    throw new InvalidEventError('Event content must be a JSON object');
  }

  const {
    ilpAddress,
    btpEndpoint,
    blsHttpEndpoint,
    settlementEngine,
    assetCode,
    assetScale,
    ilpAddresses: rawIlpAddresses,
  } = parsed;

  if (typeof ilpAddress !== 'string' || ilpAddress.length === 0) {
    throw new InvalidEventError(
      'Missing or invalid required field: ilpAddress'
    );
  }

  if (typeof btpEndpoint !== 'string' || btpEndpoint.length === 0) {
    throw new InvalidEventError(
      'Missing or invalid required field: btpEndpoint'
    );
  }

  if (typeof assetCode !== 'string' || assetCode.length === 0) {
    throw new InvalidEventError('Missing or invalid required field: assetCode');
  }

  if (typeof assetScale !== 'number' || !Number.isInteger(assetScale)) {
    throw new InvalidEventError(
      'Missing or invalid required field: assetScale'
    );
  }

  if (settlementEngine !== undefined && typeof settlementEngine !== 'string') {
    throw new InvalidEventError(
      'Invalid optional field: settlementEngine must be a string'
    );
  }

  // Parse new settlement fields
  const {
    supportedChains,
    settlementAddresses,
    preferredTokens,
    tokenNetworks,
  } = parsed;

  // supportedChains validation
  if (supportedChains !== undefined) {
    if (!Array.isArray(supportedChains)) {
      throw new InvalidEventError('supportedChains must be an array');
    }
    if (supportedChains.length === 0) {
      throw new InvalidEventError(
        'supportedChains must be a non-empty array when provided'
      );
    }
    for (const chainId of supportedChains) {
      if (typeof chainId !== 'string' || !validateChainId(chainId)) {
        throw new InvalidEventError(
          `Invalid chain identifier: ${String(chainId)}`
        );
      }
    }
  }

  // settlementAddresses validation
  if (settlementAddresses !== undefined) {
    if (!isObject(settlementAddresses)) {
      throw new InvalidEventError('settlementAddresses must be an object');
    }
    for (const [key, value] of Object.entries(settlementAddresses)) {
      if (!validateChainId(key)) {
        throw new InvalidEventError(
          `Invalid chain identifier in settlementAddresses: ${key}`
        );
      }
      if (typeof value !== 'string' || value.length === 0) {
        throw new InvalidEventError(
          'settlementAddresses values must be non-empty strings'
        );
      }
    }
    // Cross-field validation: settlementAddresses keys must be in supportedChains
    if (Array.isArray(supportedChains)) {
      const chainSet = new Set(supportedChains as string[]);
      for (const key of Object.keys(settlementAddresses)) {
        if (!chainSet.has(key)) {
          throw new InvalidEventError(
            `settlementAddresses key '${key}' is not in supportedChains`
          );
        }
      }
    }
  }

  // preferredTokens validation
  if (preferredTokens !== undefined) {
    if (!isObject(preferredTokens)) {
      throw new InvalidEventError('preferredTokens must be an object');
    }
  }

  // tokenNetworks validation
  if (tokenNetworks !== undefined) {
    if (!isObject(tokenNetworks)) {
      throw new InvalidEventError('tokenNetworks must be an object');
    }
  }

  // feePerByte validation (Story 7.4)
  const { feePerByte: rawFeePerByte } = parsed;
  let feePerByte: string;
  if (rawFeePerByte === undefined) {
    feePerByte = '0';
  } else if (
    typeof rawFeePerByte !== 'string' ||
    !/^\d+$/.test(rawFeePerByte)
  ) {
    throw new InvalidEventError(
      `Invalid feePerByte: "${String(rawFeePerByte)}" must be a non-negative integer string`
    );
  } else {
    feePerByte = rawFeePerByte;
  }

  // prefixPricing validation (Story 7.6)
  const { prefixPricing: rawPrefixPricing } = parsed;
  let prefixPricing: { basePrice: string } | undefined;
  if (rawPrefixPricing !== undefined) {
    if (!isObject(rawPrefixPricing)) {
      throw new InvalidEventError('prefixPricing must be an object');
    }
    const { basePrice } = rawPrefixPricing;
    if (typeof basePrice !== 'string' || !/^\d+$/.test(basePrice)) {
      throw new InvalidEventError(
        `Invalid prefixPricing.basePrice: "${String(basePrice)}" must be a non-negative integer string`
      );
    }
    prefixPricing = { basePrice };
  }

  // ilpAddresses validation (Story 7.3)
  let ilpAddresses: string[];
  if (rawIlpAddresses !== undefined) {
    if (!Array.isArray(rawIlpAddresses)) {
      throw new InvalidEventError('ilpAddresses must be an array');
    }
    for (const addr of rawIlpAddresses) {
      if (typeof addr !== 'string' || addr.length === 0) {
        throw new InvalidEventError(
          'ilpAddresses elements must be non-empty strings'
        );
      }
      if (!isValidIlpAddressStructure(addr)) {
        throw new InvalidEventError(
          `Invalid ILP address in ilpAddresses: "${addr}"`
        );
      }
    }
    ilpAddresses = rawIlpAddresses as string[];
  } else {
    // Backward-compatible default: wrap the singular ilpAddress in an array
    ilpAddresses = [ilpAddress as string];
  }

  return {
    ilpAddress,
    btpEndpoint,
    ...(blsHttpEndpoint !== undefined &&
      typeof blsHttpEndpoint === 'string' && { blsHttpEndpoint }),
    assetCode,
    assetScale,
    ...(settlementEngine !== undefined && { settlementEngine }),
    supportedChains:
      supportedChains !== undefined ? (supportedChains as string[]) : [],
    settlementAddresses:
      settlementAddresses !== undefined
        ? (settlementAddresses as Record<string, string>)
        : {},
    ...(preferredTokens !== undefined && {
      preferredTokens: preferredTokens as Record<string, string>,
    }),
    ...(tokenNetworks !== undefined && {
      tokenNetworks: tokenNetworks as Record<string, string>,
    }),
    ilpAddresses,
    feePerByte,
    ...(prefixPricing !== undefined && { prefixPricing }),
  };
}

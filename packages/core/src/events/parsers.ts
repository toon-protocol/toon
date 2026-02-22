/**
 * Parsers for ILP-related Nostr events.
 */

import type { NostrEvent } from 'nostr-tools/pure';
import { nip44 } from 'nostr-tools';
import { ILP_PEER_INFO_KIND, SPSP_REQUEST_KIND, SPSP_RESPONSE_KIND } from '../constants.js';
import { InvalidEventError } from '../errors.js';
import type { IlpPeerInfo, SpspRequest, SpspResponse } from '../types.js';

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

  const { ilpAddress, btpEndpoint, blsHttpEndpoint, settlementEngine, assetCode, assetScale } =
    parsed;

  if (typeof ilpAddress !== 'string' || ilpAddress.length === 0) {
    throw new InvalidEventError('Missing or invalid required field: ilpAddress');
  }

  if (typeof btpEndpoint !== 'string' || btpEndpoint.length === 0) {
    throw new InvalidEventError('Missing or invalid required field: btpEndpoint');
  }

  if (typeof assetCode !== 'string' || assetCode.length === 0) {
    throw new InvalidEventError('Missing or invalid required field: assetCode');
  }

  if (typeof assetScale !== 'number' || !Number.isInteger(assetScale)) {
    throw new InvalidEventError('Missing or invalid required field: assetScale');
  }

  if (
    settlementEngine !== undefined &&
    typeof settlementEngine !== 'string'
  ) {
    throw new InvalidEventError('Invalid optional field: settlementEngine must be a string');
  }

  // Parse new settlement fields
  const { supportedChains, settlementAddresses, preferredTokens, tokenNetworks } = parsed;

  // supportedChains validation
  if (supportedChains !== undefined) {
    if (!Array.isArray(supportedChains)) {
      throw new InvalidEventError('supportedChains must be an array');
    }
    if (supportedChains.length === 0) {
      throw new InvalidEventError('supportedChains must be a non-empty array when provided');
    }
    for (const chainId of supportedChains) {
      if (typeof chainId !== 'string' || !validateChainId(chainId)) {
        throw new InvalidEventError(`Invalid chain identifier: ${String(chainId)}`);
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
        throw new InvalidEventError(`Invalid chain identifier in settlementAddresses: ${key}`);
      }
      if (typeof value !== 'string' || value.length === 0) {
        throw new InvalidEventError('settlementAddresses values must be non-empty strings');
      }
    }
    // Cross-field validation: settlementAddresses keys must be in supportedChains
    if (Array.isArray(supportedChains)) {
      const chainSet = new Set(supportedChains as string[]);
      for (const key of Object.keys(settlementAddresses)) {
        if (!chainSet.has(key)) {
          throw new InvalidEventError(`settlementAddresses key '${key}' is not in supportedChains`);
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

  return {
    ilpAddress,
    btpEndpoint,
    ...(blsHttpEndpoint !== undefined && typeof blsHttpEndpoint === 'string' && { blsHttpEndpoint }),
    assetCode,
    assetScale,
    ...(settlementEngine !== undefined && { settlementEngine }),
    supportedChains: supportedChains !== undefined ? (supportedChains as string[]) : [],
    settlementAddresses: settlementAddresses !== undefined
      ? (settlementAddresses as Record<string, string>)
      : {},
    ...(preferredTokens !== undefined && { preferredTokens: preferredTokens as Record<string, string> }),
    ...(tokenNetworks !== undefined && { tokenNetworks: tokenNetworks as Record<string, string> }),
  };
}

/**
 * Parses and decrypts a kind:23195 Nostr event into an SpspResponse object.
 *
 * @param event - The Nostr event to parse
 * @param secretKey - The recipient's secret key for decryption
 * @param senderPubkey - The sender's pubkey (event author)
 * @returns The parsed SpspResponse object
 * @throws InvalidEventError if the event is malformed, decryption fails, or missing required fields
 */
export function parseSpspResponse(
  event: NostrEvent,
  secretKey: Uint8Array,
  senderPubkey: string
): SpspResponse {
  if (event.kind !== SPSP_RESPONSE_KIND) {
    throw new InvalidEventError(
      `Expected event kind ${SPSP_RESPONSE_KIND}, got ${event.kind}`
    );
  }

  let decrypted: string;
  try {
    const conversationKey = nip44.getConversationKey(secretKey, senderPubkey);
    decrypted = nip44.decrypt(event.content, conversationKey);
  } catch (err) {
    throw new InvalidEventError(
      'Failed to decrypt event content',
      err instanceof Error ? err : undefined
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decrypted);
  } catch (err) {
    throw new InvalidEventError(
      'Failed to parse decrypted content as JSON',
      err instanceof Error ? err : undefined
    );
  }

  if (!isObject(parsed)) {
    throw new InvalidEventError('Decrypted content must be a JSON object');
  }

  const { requestId, destinationAccount, sharedSecret } = parsed;

  if (typeof requestId !== 'string' || requestId.length === 0) {
    throw new InvalidEventError('Missing or invalid required field: requestId');
  }

  if (typeof destinationAccount !== 'string' || destinationAccount.length === 0) {
    throw new InvalidEventError(
      'Missing or invalid required field: destinationAccount'
    );
  }

  if (typeof sharedSecret !== 'string' || sharedSecret.length === 0) {
    throw new InvalidEventError('Missing or invalid required field: sharedSecret');
  }

  // Parse optional settlement fields
  const { negotiatedChain, settlementAddress, tokenAddress, tokenNetworkAddress, channelId, settlementTimeout } = parsed;

  if (negotiatedChain !== undefined) {
    if (typeof negotiatedChain !== 'string' || negotiatedChain.length === 0 || !validateChainId(negotiatedChain)) {
      throw new InvalidEventError(`Invalid negotiatedChain: ${String(negotiatedChain)}`);
    }
  }

  if (settlementAddress !== undefined && (typeof settlementAddress !== 'string' || settlementAddress.length === 0)) {
    throw new InvalidEventError('settlementAddress must be a non-empty string');
  }

  if (tokenAddress !== undefined && typeof tokenAddress !== 'string') {
    throw new InvalidEventError('tokenAddress must be a string');
  }

  if (tokenNetworkAddress !== undefined && typeof tokenNetworkAddress !== 'string') {
    throw new InvalidEventError('tokenNetworkAddress must be a string');
  }

  if (channelId !== undefined && (typeof channelId !== 'string' || channelId.length === 0)) {
    throw new InvalidEventError('channelId must be a non-empty string');
  }

  if (settlementTimeout !== undefined) {
    if (!Number.isInteger(settlementTimeout) || (settlementTimeout as number) <= 0) {
      throw new InvalidEventError('settlementTimeout must be a positive integer');
    }
  }

  return {
    requestId,
    destinationAccount,
    sharedSecret,
    ...(negotiatedChain !== undefined && { negotiatedChain: negotiatedChain as string }),
    ...(settlementAddress !== undefined && { settlementAddress: settlementAddress as string }),
    ...(tokenAddress !== undefined && { tokenAddress: tokenAddress as string }),
    ...(tokenNetworkAddress !== undefined && { tokenNetworkAddress: tokenNetworkAddress as string }),
    ...(channelId !== undefined && { channelId: channelId as string }),
    ...(settlementTimeout !== undefined && { settlementTimeout: settlementTimeout as number }),
  };
}

/**
 * Parses and decrypts a kind:23194 Nostr event into an SpspRequest object.
 *
 * @param event - The Nostr event to parse
 * @param secretKey - The recipient's secret key for decryption
 * @param senderPubkey - The sender's pubkey (event author)
 * @returns The parsed SpspRequest object
 * @throws InvalidEventError if the event is malformed, decryption fails, or missing required fields
 */
export function parseSpspRequest(
  event: NostrEvent,
  secretKey: Uint8Array,
  senderPubkey: string
): SpspRequest {
  if (event.kind !== SPSP_REQUEST_KIND) {
    throw new InvalidEventError(
      `Expected event kind ${SPSP_REQUEST_KIND}, got ${event.kind}`
    );
  }

  let decrypted: string;
  try {
    const conversationKey = nip44.getConversationKey(secretKey, senderPubkey);
    decrypted = nip44.decrypt(event.content, conversationKey);
  } catch (err) {
    throw new InvalidEventError(
      'Failed to decrypt event content',
      err instanceof Error ? err : undefined
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decrypted);
  } catch (err) {
    throw new InvalidEventError(
      'Failed to parse decrypted content as JSON',
      err instanceof Error ? err : undefined
    );
  }

  if (!isObject(parsed)) {
    throw new InvalidEventError('Decrypted content must be a JSON object');
  }

  const { requestId, timestamp } = parsed;

  if (typeof requestId !== 'string' || requestId.length === 0) {
    throw new InvalidEventError('Missing or invalid required field: requestId');
  }

  if (typeof timestamp !== 'number' || !Number.isInteger(timestamp)) {
    throw new InvalidEventError('Missing or invalid required field: timestamp');
  }

  // Parse optional settlement fields
  const { ilpAddress, supportedChains, settlementAddresses, preferredTokens } = parsed;

  if (ilpAddress !== undefined && (typeof ilpAddress !== 'string' || ilpAddress.length === 0)) {
    throw new InvalidEventError('ilpAddress must be a non-empty string');
  }

  if (supportedChains !== undefined) {
    if (!Array.isArray(supportedChains)) {
      throw new InvalidEventError('supportedChains must be an array');
    }
    for (const chainId of supportedChains) {
      if (typeof chainId !== 'string' || !validateChainId(chainId)) {
        throw new InvalidEventError(`Invalid chain identifier in SPSP request: ${String(chainId)}`);
      }
    }
  }

  if (settlementAddresses !== undefined) {
    if (!isObject(settlementAddresses)) {
      throw new InvalidEventError('settlementAddresses must be an object');
    }
    for (const [key, value] of Object.entries(settlementAddresses)) {
      if (!validateChainId(key)) {
        throw new InvalidEventError(`Invalid chain identifier in SPSP request: ${key}`);
      }
      if (typeof value !== 'string' || value.length === 0) {
        throw new InvalidEventError('settlementAddresses values must be non-empty strings');
      }
    }
    // Cross-field validation: settlementAddresses keys must be in supportedChains
    if (Array.isArray(supportedChains)) {
      const chainSet = new Set(supportedChains as string[]);
      for (const key of Object.keys(settlementAddresses)) {
        if (!chainSet.has(key)) {
          throw new InvalidEventError(`settlementAddresses key '${key}' is not in supportedChains`);
        }
      }
    }
  }

  if (preferredTokens !== undefined) {
    if (!isObject(preferredTokens)) {
      throw new InvalidEventError('preferredTokens must be an object');
    }
  }

  return {
    requestId,
    timestamp,
    ...(ilpAddress !== undefined && { ilpAddress }),
    ...(supportedChains !== undefined && { supportedChains: supportedChains as string[] }),
    ...(settlementAddresses !== undefined && { settlementAddresses: settlementAddresses as Record<string, string> }),
    ...(preferredTokens !== undefined && { preferredTokens: preferredTokens as Record<string, string> }),
  };
}

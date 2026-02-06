/**
 * Parsers for ILP-related Nostr events.
 */

import type { NostrEvent } from 'nostr-tools/pure';
import { ILP_PEER_INFO_KIND, SPSP_INFO_KIND } from '../constants.js';
import { InvalidEventError } from '../errors.js';
import type { IlpPeerInfo, SpspInfo } from '../types.js';

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

  const { ilpAddress, btpEndpoint, settlementEngine, assetCode, assetScale } =
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

  return {
    ilpAddress,
    btpEndpoint,
    assetCode,
    assetScale,
    ...(settlementEngine !== undefined && { settlementEngine }),
  };
}

/**
 * Parses a kind:10047 Nostr event into an SpspInfo object.
 *
 * @param event - The Nostr event to parse
 * @returns The parsed SpspInfo object
 * @throws InvalidEventError if the event is malformed or missing required fields
 */
export function parseSpspInfo(event: NostrEvent): SpspInfo {
  if (event.kind !== SPSP_INFO_KIND) {
    throw new InvalidEventError(
      `Expected event kind ${SPSP_INFO_KIND}, got ${event.kind}`
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

  const { destinationAccount, sharedSecret } = parsed;

  if (typeof destinationAccount !== 'string' || destinationAccount.length === 0) {
    throw new InvalidEventError(
      'Missing or invalid required field: destinationAccount'
    );
  }

  if (typeof sharedSecret !== 'string' || sharedSecret.length === 0) {
    throw new InvalidEventError('Missing or invalid required field: sharedSecret');
  }

  return {
    destinationAccount,
    sharedSecret,
  };
}

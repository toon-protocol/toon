/**
 * Parsers for ILP-related Nostr events.
 */

import type { NostrEvent } from 'nostr-tools/pure';
import { nip44 } from 'nostr-tools';
import { ILP_PEER_INFO_KIND, SPSP_REQUEST_KIND, SPSP_RESPONSE_KIND } from '../constants.js';
import { InvalidEventError } from '../errors.js';
import type { IlpPeerInfo, SpspRequest, SpspResponse } from '../types.js';

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

  return {
    requestId,
    destinationAccount,
    sharedSecret,
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

  return {
    requestId,
    timestamp,
  };
}

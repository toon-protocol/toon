/**
 * Builders for ILP-related Nostr events.
 */

import { finalizeEvent } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import { nip44 } from 'nostr-tools';
import { ILP_PEER_INFO_KIND, SPSP_REQUEST_KIND, SPSP_RESPONSE_KIND } from '../constants.js';
import type { IlpPeerInfo, SpspRequest, SpspResponse } from '../types.js';

/**
 * Builds and signs a kind:10032 Nostr event from IlpPeerInfo data.
 *
 * @param info - The ILP peer info to serialize into the event
 * @param secretKey - The secret key to sign the event with
 * @returns A signed Nostr event
 */
export function buildIlpPeerInfoEvent(
  info: IlpPeerInfo,
  secretKey: Uint8Array
): NostrEvent {
  return finalizeEvent(
    {
      kind: ILP_PEER_INFO_KIND,
      content: JSON.stringify(info),
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
    },
    secretKey
  );
}

/**
 * Result of building an SPSP request event.
 */
export interface SpspRequestEventResult {
  /** The signed Nostr event */
  event: NostrEvent;
  /** The request ID for correlating with responses */
  requestId: string;
}

/**
 * Builds and signs a kind:23194 encrypted SPSP request event.
 *
 * @param recipientPubkey - The recipient's pubkey (64-character hex)
 * @param secretKey - The sender's secret key for signing and encryption
 * @returns The signed event and the requestId for response correlation
 */
export function buildSpspRequestEvent(
  recipientPubkey: string,
  secretKey: Uint8Array
): SpspRequestEventResult {
  const requestId = crypto.randomUUID();
  const timestamp = Math.floor(Date.now() / 1000);

  const payload: SpspRequest = {
    requestId,
    timestamp,
  };

  // Encrypt payload using NIP-44
  const conversationKey = nip44.getConversationKey(secretKey, recipientPubkey);
  const encryptedContent = nip44.encrypt(JSON.stringify(payload), conversationKey);

  const event = finalizeEvent(
    {
      kind: SPSP_REQUEST_KIND,
      content: encryptedContent,
      tags: [['p', recipientPubkey]],
      created_at: timestamp,
    },
    secretKey
  );

  return { event, requestId };
}

/**
 * Builds and signs a kind:23195 encrypted SPSP response event.
 *
 * @param response - The SpspResponse payload to send
 * @param senderPubkey - The original request sender's pubkey (recipient of response)
 * @param secretKey - The responder's secret key for signing and encryption
 * @param requestEventId - Optional event ID of the original request for reference
 * @returns A signed Nostr event
 */
export function buildSpspResponseEvent(
  response: SpspResponse,
  senderPubkey: string,
  secretKey: Uint8Array,
  requestEventId?: string
): NostrEvent {
  // Encrypt payload using NIP-44 for the original sender
  const conversationKey = nip44.getConversationKey(secretKey, senderPubkey);
  const encryptedContent = nip44.encrypt(JSON.stringify(response), conversationKey);

  const tags: string[][] = [['p', senderPubkey]];
  if (requestEventId) {
    tags.push(['e', requestEventId]);
  }

  return finalizeEvent(
    {
      kind: SPSP_RESPONSE_KIND,
      content: encryptedContent,
      tags,
      created_at: Math.floor(Date.now() / 1000),
    },
    secretKey
  );
}

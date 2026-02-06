/**
 * Builders for ILP-related Nostr events.
 */

import { finalizeEvent } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';
import { ILP_PEER_INFO_KIND, SPSP_INFO_KIND } from '../constants.js';
import type { IlpPeerInfo, SpspInfo } from '../types.js';

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
 * Builds and signs a kind:10047 Nostr event from SpspInfo data.
 *
 * @param info - The SPSP info to serialize into the event
 * @param secretKey - The secret key to sign the event with
 * @returns A signed Nostr event
 */
export function buildSpspInfoEvent(
  info: SpspInfo,
  secretKey: Uint8Array
): NostrEvent {
  return finalizeEvent(
    {
      kind: SPSP_INFO_KIND,
      content: JSON.stringify(info),
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
    },
    secretKey
  );
}

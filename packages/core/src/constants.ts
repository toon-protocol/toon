/**
 * Nostr event kind constants for ILP-related events.
 *
 * These follow the NIP convention for replaceable (10000-19999) and
 * ephemeral (20000-29999) event kinds.
 */

/**
 * ILP Peer Info (kind 10032)
 * Replaceable event containing connector's ILP address, BTP endpoint, and settlement info.
 */
export const ILP_PEER_INFO_KIND = 10032;

/**
 * SPSP Request (kind 23194)
 * Ephemeral request for fresh SPSP parameters (NIP-47 style).
 */
export const SPSP_REQUEST_KIND = 23194;

/**
 * SPSP Response (kind 23195)
 * Ephemeral response with SPSP parameters.
 */
export const SPSP_RESPONSE_KIND = 23195;

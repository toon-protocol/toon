/**
 * Nostr event kind constants for blob storage requests.
 */

/**
 * Blob Storage DVM kind (kind 5094).
 * Used for permanent blob storage requests (e.g., Arweave uploads).
 * The blob data is base64-encoded in the `i` tag with type `blob`.
 * Payment is carried in the ILP PREPARE packet (prepaid model).
 */
export const BLOB_STORAGE_REQUEST_KIND = 5094;

/**
 * Blob Storage Result DVM kind (kind 6094).
 * Reserved for informational result events. In the prepaid model,
 * the Arweave tx ID is returned in the ILP FULFILL data field,
 * NOT as a kind:6094 event.
 */
export const BLOB_STORAGE_RESULT_KIND = 6094;

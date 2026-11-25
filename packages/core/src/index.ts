/**
 * @toon-protocol/core
 *
 * The TOON codec, NIP-34 (`./nip34`), base58 and the kind 5094 blob storage
 * request builder and parser.
 */

export const VERSION = '0.1.0';

// Event kind constants
export {
  BLOB_STORAGE_REQUEST_KIND,
  BLOB_STORAGE_RESULT_KIND,
} from './constants.js';

// Error classes
export { ToonError } from './errors.js';

// Kind 5094 blob storage request builder and parser
export {
  buildBlobStorageRequest,
  parseBlobStorageRequest,
  type BlobStorageRequestParams,
  type ParsedBlobStorageRequest,
} from './events/index.js';

// Base58 (Bitcoin/Solana alphabet)
export { base58Encode, base58Decode } from './base58.js';

// TOON codec
export {
  encodeEventToToon,
  encodeEventToToonString,
  ToonEncodeError,
  decodeEventFromToon,
  ToonDecodeError,
  shallowParseToon,
  type ToonRoutingMeta,
} from './toon/index.js';

// NIP-34: Git stuff
// NOTE: Import from '@toon-protocol/core/nip34' to use Git integration
// This avoids loading simple-git dependency when not needed

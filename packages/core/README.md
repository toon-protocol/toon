# @toon-protocol/core

The TOON codec, NIP-34, base58 and the kind 5094 blob storage request builder and parser.

> This is an internal package. Most users should start with [`@toon-protocol/client`](https://github.com/toon-protocol/toon-client).

## Install

```bash
npm install @toon-protocol/core
```

## Exports

The package has three entry points: `.`, `./toon` and `./nip34`.

### TOON codec

Encode and decode Nostr events in the compact TOON format. Also exported from `./toon`.

```ts
import { encodeEventToToon, decodeEventFromToon, shallowParseToon } from '@toon-protocol/core';

const toonBytes = encodeEventToToon(nostrEvent);
const event = decodeEventFromToon(toonBytes);

// Fast metadata extraction without a full decode
const meta = shallowParseToon(toonBytes);
console.log(meta.kind, meta.pubkey);
```

### Kind 5094 blob storage request

```ts
import { buildBlobStorageRequest, parseBlobStorageRequest } from '@toon-protocol/core';
```

### Base58

```ts
import { base58Encode, base58Decode } from '@toon-protocol/core';
```

### NIP-34

Git over Nostr: kind constants, `NIP34Handler` and `ForgejoClient`. Import from `@toon-protocol/core/nip34`, not the package root, so `simple-git` loads only when needed. See [`src/nip34/README.md`](src/nip34/README.md).

## Full API

| Category | Exports |
|----------|---------|
| **Codec** | `encodeEventToToon`, `encodeEventToToonString`, `decodeEventFromToon`, `shallowParseToon`, `ToonRoutingMeta` |
| **Blob storage** | `buildBlobStorageRequest`, `parseBlobStorageRequest`, `BLOB_STORAGE_REQUEST_KIND`, `BLOB_STORAGE_RESULT_KIND` |
| **Base58** | `base58Encode`, `base58Decode` |
| **Errors** | `ToonError`, `ToonEncodeError`, `ToonDecodeError` |
| **Other** | `VERSION` |

## License

MIT

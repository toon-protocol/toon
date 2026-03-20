# @toon-protocol/core

Peer discovery, bootstrap, settlement negotiation, and TOON event encoding for the TOON Protocol network.

> This is an internal package. Most users should start with [`@toon-protocol/client`](../client) or [`@toon-protocol/sdk`](../sdk).

## Install

```bash
npm install @toon-protocol/core
```

## Key Exports

### TOON Codec

Encode and decode Nostr events in the compact TOON binary format.

```ts
import { encodeEventToToon, decodeEventFromToon, shallowParseToon } from '@toon-protocol/core';

// Encode a Nostr event to TOON binary format
const toonBytes = encodeEventToToon(nostrEvent);

// Decode back to a Nostr event
const event = decodeEventFromToon(toonBytes);

// Fast metadata extraction without full decode
const meta = shallowParseToon(toonBytes);
console.log(meta.kind, meta.pubkey);
```

### Peer Discovery

Discover ILP peers from Nostr relays, genesis nodes, or ArDrive registries.

```ts
import { NostrPeerDiscovery, GenesisPeerLoader, parseIlpPeerInfo } from '@toon-protocol/core';

// Query Nostr relays for kind:10032 peer info events
const discovery = new NostrPeerDiscovery({ relayUrls: ['wss://relay.example.com'] });
const peers = await discovery.query();

// Or load peers from a genesis node
const loader = new GenesisPeerLoader('http://localhost:3100');
const genesisPeers = await loader.load();

// Parse a raw Nostr event into typed peer info
const peerInfo = parseIlpPeerInfo(event);
console.log(peerInfo.ilpAddress, peerInfo.btpEndpoint);
```

### Bootstrap Service

Orchestrates the full peer lifecycle: discovery, registration, settlement negotiation, and announcement.

```ts
import { BootstrapService } from '@toon-protocol/core';

const bootstrap = new BootstrapService(config);

bootstrap.addEventListener('phase', (e) => {
  console.log('Phase:', e.phase); // 'discovering' → 'registering' → 'announcing' → 'ready'
});

await bootstrap.start();
```

### Compose API (Embedded Connector)

Wire a full TOON node with zero-latency embedded connector.

```ts
import { createToonNode } from '@toon-protocol/core';

const node = createToonNode({
  connector,
  secretKey,
  basePricePerByte: 10n,
  relayPort: 7100,
});

node.on(1, async (ctx) => {
  const event = ctx.decode();
  return ctx.accept();
});

await node.start();
```

### Event Builders

Build typed Nostr events for ILP peer info, service discovery, seed relay lists, and TEE attestation.

```ts
import {
  buildIlpPeerInfoEvent,
  buildServiceDiscoveryEvent,
  buildAttestationEvent,
  buildJobRequestEvent,
} from '@toon-protocol/core';
```

### Chain Configuration

Resolve chain presets for settlement (Anvil, Arbitrum Sepolia, Arbitrum One).

```ts
import { resolveChainConfig, CHAIN_PRESETS } from '@toon-protocol/core';

const chain = resolveChainConfig('arbitrum-sepolia');
console.log(chain.chainId, chain.usdcAddress);
```

### Settlement Negotiation

Find a common settlement chain between two peers.

```ts
import { negotiateSettlementChain } from '@toon-protocol/core';

const chain = negotiateSettlementChain(peerInfo, localConfig);
```

## Full API

| Category | Exports |
|----------|---------|
| **Codec** | `encodeEventToToon`, `decodeEventFromToon`, `shallowParseToon`, `encodeEventToToonString` |
| **Discovery** | `NostrPeerDiscovery`, `GenesisPeerLoader`, `ArDrivePeerRegistry`, `SocialPeerDiscovery`, `SeedRelayDiscovery` |
| **Bootstrap** | `BootstrapService`, `createDiscoveryTracker` |
| **Compose** | `createToonNode`, `ToonNode`, `EmbeddableConnectorLike` |
| **Events** | `buildIlpPeerInfoEvent`, `buildServiceDiscoveryEvent`, `buildAttestationEvent`, `buildSeedRelayListEvent` |
| **DVM** | `buildJobRequestEvent`, `buildJobResultEvent`, `buildJobFeedbackEvent`, `parseJobRequest/Result/Feedback` |
| **Chain** | `resolveChainConfig`, `CHAIN_PRESETS`, `buildEip712Domain`, `validateChainId` |
| **Settlement** | `negotiateSettlementChain`, `resolveTokenForChain` |
| **TEE** | `AttestationVerifier`, `AttestationState`, `AttestationBootstrap`, `deriveFromKmsSeed` |
| **ILP Clients** | `createDirectIlpClient`, `createHttpIlpClient`, `createDirectConnectorAdmin`, `createHttpConnectorAdmin` |
| **Errors** | `ToonError`, `InvalidEventError`, `PeerDiscoveryError`, `ToonEncodeError`, `ToonDecodeError` |
| **Logging** | `createLogger`, `LogLevel` |

## License

MIT

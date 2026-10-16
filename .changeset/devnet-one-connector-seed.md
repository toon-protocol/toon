---
'@toon-protocol/core': minor
---

fix(discovery): collapse the genesis seed to the one devnet connector

The devnet was consolidated on 2026-10-16 from five connectors to one. The bundled seed had two entries, relay (`g.toon.relay`) and store (`g.toon.ario`), and both pointed at retired hosts (`relay-ws.devnet`, `proxy.relay.devnet`, `proxy.ario.devnet`). It now has one entry, and every value was checked against the live devnet:

- `pubkey` → `915d2990…`, the x-only form of the connector's `edgeIdentity.publicKey` from `GET https://toonprotocol.dev/ilp`
- `relayUrl` → `wss://relay.toonprotocol.dev`
- `ilpAddress` → `g.toon.relay`, the relay's NIP-11 `toon.ilp_address`
- `btpEndpoint` → `wss://toonprotocol.dev/ilp/btp`

The store entry (`499cdd71…`, `g.toon.ario`) is dropped. `g.toon.store` is now served by the same connector.

The seed no longer pins `30fdd01d…`. That pubkey was the old announce identity, but kind:10032 announces were removed (connector ADR 0046) and none exists on the live relay under any connector key. `BootstrapService`'s kind:10032 lookup therefore finds nothing on the devnet, whichever pubkey the seed holds. `TOON_GENESIS_PEERS` still overrides the bundled seed wholesale.

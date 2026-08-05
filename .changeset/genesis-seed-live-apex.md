---
'@toon-protocol/core': minor
---

fix(discovery): point the genesis peer seed at the live apex announce

The committed seed still described the retired TypeScript connector: it pinned that
connector's nostr key `3f12da6d…`, the old `g.proxy` ILP address, and the root-path
BTP endpoint `wss://proxy.devnet.toonprotocol.dev:443` that only the TypeScript edge
ever served. `ToonClient`'s bootstrap queries kind:10032 with
`authors: [<seed pubkey>]`, so a client got `EOSE, found 0 events` and could not open
a channel at all — measured live on devnet, 2026-08-05.

All three facts are refreshed against the live announce on
`wss://relay-ws.devnet.toonprotocol.dev`, read raw over NIP-01 and validated with
`parseIlpPeerInfo`:

- `pubkey` → `30fdd01d…`, the apex announcer's durable identity. Its
  `edgeIdentity.publicKey` matches what `GET /ilp/identity` reports on the apex box,
  so this announce really does describe that connector.
- `ilpAddress` → `g.toon`
- `btpEndpoint` → `wss://proxy.devnet.toonprotocol.dev/ilp/btp`, the Rust edge's path.

The endpoint change matters on its own: a seed that names the root path sends a client
to an address where the Rust connector answers 400, which reads exactly like the box
being down.

---
"@toon-protocol/core": minor
---

fix(discovery): reseed the genesis peers with both surviving devnet boxes

toon-meta#310 retires the devnet apex, leaving two independent boxes: the relay
and the store. The bundled seed had one entry, and all four of its fields
described the apex — a fresh install would bootstrap against a box that no
longer exists.

The seed now carries one entry per surviving node, both read from their live
kind:10032 self-announces on `wss://relay-ws.devnet.toonprotocol.dev`:

- **relay** — pubkey `30fdd01d…`, the apex's announce identity, which the
  relay box adopts (toon-meta#310/#311) so already-deployed clients repair
  themselves against the same author; ILP address `g.toon.relay`; its own BTP
  endpoint `wss://proxy.relay.devnet.toonprotocol.dev/ilp/btp`.
- **store** — its own announce pubkey `499cdd71…` (unaffected by the
  cutover); ILP address `g.toon.ario`; its own BTP endpoint
  `wss://proxy.ario.devnet.toonprotocol.dev/ilp/btp`.

`relayUrl` is a required field on every entry and the store fronts no relay,
so both entries name the relay box's `relay-ws` URL — unchanged through the
cutover, so this seed is valid both before and after it lands.

`GenesisPeerLoader.test.ts` gains a shape guard (`peers.length === 2`) plus
literal pins for both entries, so a future edit that empties the array or
drops a node fails loudly instead of shipping a dead or partial seed (the
failure mode toon#56 already had once). `TOON_GENESIS_PEERS` still overrides
the bundled seed wholesale, unchanged.

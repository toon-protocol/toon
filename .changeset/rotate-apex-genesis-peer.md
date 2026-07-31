---
'@toon-protocol/core': patch
---

Point the bundled devnet genesis peer at the apex's rotated announce identity.

The devnet apex node's Nostr identity was rotated, so the pubkey baked into
`genesis-peers.json` no longer matched the live kind:10032 self-announce.
Clients bootstrapping from the bundled seed would trust a pubkey the apex no
longer signs with. Updated to `3f12da6d…`.

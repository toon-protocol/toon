---
'@toon-protocol/core': patch
---

Refresh the committed genesis peer seed to the live devnet apex identity (pubkey `2813187e…`, `g.proxy`, `wss://proxy.devnet.toonprotocol.dev:443`). The 2.0.0 seed pointed at a rotated/dead box identity (`522e9309…`), so clients bootstrapping from the shipped seed found zero peers. Adds tests that the shipped seed is non-empty, fully schema-valid, and pins the live apex, so a dead or empty seed can no longer ship silently.

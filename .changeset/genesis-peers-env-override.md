---
'@toon-protocol/core': patch
---

Add `TOON_GENESIS_PEERS` environment variable override for the bundled genesis peer seed. When set, its JSON array replaces `genesis-peers.json` entirely (set to `[]` to disable bundled peers — e.g. private networks or hermetic tests). `additionalPeersJson` still merges on top.

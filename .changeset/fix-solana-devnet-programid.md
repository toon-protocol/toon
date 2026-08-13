---
"@toon-protocol/core": patch
---

fix(core): stop shipping a stale local-validator programId as the `solana-devnet` preset's default

`SOLANA_CHAIN_PRESETS['solana-devnet']` (and thus `resolveSolanaChainConfig('solana-devnet')`)
defaulted `programId` to `EdJxYPDxGvaJuu57DSUptf4soLv8enpdyQJJhHDLiydG` — a pre-cutover
self-hosted-validator id that `network-profile.ts` already documents as retired. Worse, this
preset's `rpcUrl` is `http://localhost:19899` (a local `solana-test-validator`, per the dev/e2e
stack), where a deployed program's id is a fresh keypair generated per `cargo build-sbf` build —
no fixed default can be correct there, and it is a different program than the one deployed on the
public Solana devnet cluster (see `network-profile.ts`'s `SOLANA_TIER`).

`programId` now defaults to `''` for `solana-devnet`; callers targeting a local validator must
supply the id of whatever they deployed via the existing `SOLANA_PROGRAM_ID` env override.

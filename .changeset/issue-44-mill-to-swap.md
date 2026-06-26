---
"@toon-protocol/core": minor
"@toon-protocol/sdk": minor
---

Rename all `mill` vocabulary to `swap` across public API and internals.

- `MillSignerConfig` → `SwapSignerConfig`
- `millSignerAddress` → `swapSignerAddress` (on `SettlementClaim`, `SettlementBundle`)
- `millEphemeralPubkey` → `swapEphemeralPubkey`
- `millPubkey` / `millIlpAddress` → `swapPubkey` / `swapIlpAddress` (on `StreamSwapParams`)
- Error codes `MILL_SIGNER_MISMATCH` / `MILL_RECIPIENT_MISMATCH` → `SWAP_SIGNER_MISMATCH` / `SWAP_RECIPIENT_MISMATCH`
- Scripts renamed: `mill-swap.mjs` → `swap.mjs`, `mill-swap-mina.mjs` → `swap-mina.mjs`

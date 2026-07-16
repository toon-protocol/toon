---
'@toon-protocol/core': minor
'@toon-protocol/sdk': minor
---

extract digest into shared settlement-digest leaf (no behavior change), refs #329

Phase 1 of connector#329: the v2 EIP-712 balance-proof digest (EVM claim +
cooperative-close, the Solana/Mina message digests, and the pure EVM signer
recovery) now lives in a new dependency-light leaf package,
**`@toon-protocol/settlement-digest`** (`@noble/hashes` + `@noble/curves` only —
no `ethers`/ABI libs, no dependency on `@toon-protocol/core`). This lets the
connector's off-chain inbound verifier share the EXACT same digest bytes without
pulling in core's heavy transitive tree or its optional circular peer-dep.

`@toon-protocol/core` (`settlement/hashes.ts`) and `@toon-protocol/sdk`
(`settlement/evm.ts`) adopt-and-re-export the leaf: every existing export
(`balanceProofHashEvm`, `coopCloseHashEvm`, `eip712DomainSeparatorEvm`,
`balanceProofHashSolana`, `minaHashToField`, `balanceProofFieldsMina`, the byte
helpers, and `recoverEvmSignerAddress`) resolves identically. This is a **pure
refactor** — the golden vectors from `docs/rolling-swap-v2-digest-spec.md` §4
reproduce byte-for-byte, so no consumer sees a behavior change (minor, additive).

Note: `@toon-protocol/settlement-digest@1.0.0` is a brand-new package; the
release flow publishes it via `changeset publish` (which publishes any public
workspace package whose version is not yet on npm), so it ships at exactly
1.0.0 without a version-bump entry here.

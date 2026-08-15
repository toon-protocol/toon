---
"@toon-protocol/sdk": patch
---

fix(sdk): accept EIP-55 checksummed EVM `chain-recipient` addresses in `createSwapHandler`

`validateChainRecipient`'s local `SWAP_HANDLER_EVM_ADDRESS_REGEX` duplicate (in `swap-handler.ts`)
tested EVM addresses against a lowercase-only regex, where released clients send EIP-55
checksummed (mixed-case) addresses. Every stock-client swap packet was rejected as a malformed
rumor (`T00 Internal error`), even though the sender-side validator (`validateChainAddress` in
`stream-swap.ts`, fixed under #153) already accepts the same checksummed input.

`validateChainRecipient` now lowercase-normalizes an EVM value before testing it, matching
`validateChainAddress`'s existing behavior. `findChainRecipient` returns the lowercased value for
`evm:*` chains, so downstream consumers (e.g. `IssueClaimParams.chainRecipient`) get a single
normalized casing regardless of which casing the sender used.

`createSwapHandler` also now rejects a missing or malformed `chain-recipient` with `F01` and a
message naming the field and the expected shape per chain (e.g. `missing or malformed
chain-recipient for evm:base:8453 — expected 0x + 40 hex chars`), instead of the opaque
`T00 Internal error` it emitted before. This is a permanent sender-side error, not a transient
one, so a specific reject reason lets the sender self-diagnose and correct the address instead of
retrying blind — per #200's second ask and the PR #201 review resolution. **Supersedes Story
12.9 AC-14b's original T00 pin** (`packages/sdk/src/swap-handler.test.ts` tests T-5/T-6a/T-6b/T-6c
now assert F01).

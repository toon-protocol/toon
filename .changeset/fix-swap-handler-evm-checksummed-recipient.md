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

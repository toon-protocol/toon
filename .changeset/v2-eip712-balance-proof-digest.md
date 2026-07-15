---
"@toon-protocol/core": major
"@toon-protocol/sdk": major
---

v2 EIP-712 domain-separated balance-proof digest (refs connector#324 finding #1).

`balanceProofHashEvm` (core) and the sdk settlement builder now emit the EIP-712 v2
claim digest, folding `chainId` **and** `verifyingContract` into the signed preimage
via a standard `EIP712Domain(name="RollingSwapChannel", version="2", chainId,
verifyingContract)`. This closes the cross-chain/cross-deployment replay hole where a
swap-signed claim redeemed on one `(chainId, contract)` pair could be replayed verbatim
on another sharing the same `channelId`.

**Breaking (ABI/wire):**
- `balanceProofHashEvm(...)` gains two REQUIRED inputs — `chainId` + `verifyingContract` —
  and returns the EIP-712 claim digest instead of the v1 raw-keccak digest. `version="2"`
  makes the cutover fail-closed (v1 signatures can never validate as v2 and vice-versa).
- New `coopCloseHashEvm(...)` (cooperative-close ack digest, distinct `CooperativeClose`
  type hash) and `eip712DomainSeparatorEvm(...)` helper, both exported.
- sdk `recoverEvmSignerAddress` / `verifyEvmClaimSignature` / `buildSettlementTx` /
  `verifyAccumulatedClaim` thread `chainId` + `verifyingContract` from the validated EVM
  `SwapSignerConfig.chainId` + `.contractAddress`; `coopCloseHashEvm` +
  `eip712DomainSeparatorEvm` re-exported.

Must ship in lockstep with the swap signer and toon-client legs of the coordinated
migration.

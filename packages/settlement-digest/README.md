# @toon-protocol/settlement-digest

Dependency-light leaf for the RollingSwapChannel **v2 EIP-712 balance-proof
digest** and the Solana / Mina balance-proof message digests, plus **pure EVM
signer recovery**. Its only runtime dependencies are `@noble/hashes` and
`@noble/curves` — no `ethers`, no ABI libraries, no `@toon-protocol/core`.

This package is the single source of truth for the digest bytes that every
signer and verifier in the TOON ecosystem depends on:

- `@toon-protocol/core` / `@toon-protocol/sdk` (adopt-and-re-export)
- the swap payment-channel signer
- the toon-client settlement leg
- the connector's off-chain inbound verifier

It was extracted (Phase 1 of connector#329) from `@toon-protocol/core`
(`settlement/hashes.ts`) and `@toon-protocol/sdk` (`settlement/evm.ts`) with **no
behavior change** — the golden vectors in `docs/rolling-swap-v2-digest-spec.md`
§4 reproduce byte-for-byte.

## API

Byte helpers: `hexToBytes`, `bigintToBytes32BE`, `concatBytes`.

EVM v2 EIP-712 digest: `eip712DomainSeparatorEvm`, `balanceProofHashEvm`,
`coopCloseHashEvm`, plus the `*_TYPEHASH` / `DOMAIN_*_HASH` constants.

Non-EVM message digests: `balanceProofHashSolana`, `minaHashToField`,
`balanceProofFieldsMina`.

Pure recover/verify (plain params + a 65-byte `r||s||v` signature):
`recoverEvmSigner(digest, sig65)`, `recoverEvmClaimSigner(params, sig65)`,
`verifyEvmClaimSignature(params, sig65, expected)` — plus the
`EvmClaimDigestParams` type.

## The v2 digest

```
domainSeparator = keccak256(abi.encode(
  EIP712DOMAIN_TYPEHASH, keccak256("RollingSwapChannel"), keccak256("2"),
  chainId, verifyingContract))
structHash      = keccak256(abi.encode(TYPEHASH, fields...))
digest          = keccak256(0x1901 || domainSeparator || structHash)
```

`chainId` + `verifyingContract` are folded into the signed preimage so a claim
signed for one `(chainId, contract)` pair can never be replayed on another
(refs connector#324 finding #1).

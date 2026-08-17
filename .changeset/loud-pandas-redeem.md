---
'@toon-protocol/settlement-digest': minor
'@toon-protocol/core': minor
'@toon-protocol/sdk': minor
---

Make the Solana settlement bundle EXECUTABLE, and refuse the claims that are not
(toon#214).

`buildSettlementTx`'s Solana branch emitted a transaction no validator could ever
run. Every field of it was wrong against the deployed native payment-channel
program (connector `packages/solana-program`), and nothing caught it because the
SDK verified its own signature scheme in a closed loop and asserted only
`unsignedTxBytes.length > 0`:

| | emitted before | what the program requires |
| --- | --- | --- |
| discriminator | `sha256("global:update_balance")[0..8]` (Anchor) | `[6,0,0,0,0,0,0,0]` (`instruction.rs:12`) |
| payload | `cumulative(8 LE) \|\| nonce(8 LE)` | `nonce(8 LE) \|\| transferred_amount(8 LE)` |
| signature | inlined into the program's instruction data | out of band, in an Ed25519 precompile instruction at index 0 |
| signed message | `sha256(utf8(channelId) \|\| cumulative(32BE) \|\| nonce(32BE) \|\| utf8(recipient))` | the RAW 48 bytes `channel_pda \|\| nonce(8 LE) \|\| transferred_amount(8 LE)` |
| accounts | `[recipient(signer), swapSigner, channelId, program]`, program also passed as an account of the instruction | `[fee_payer(signer), claimer, channel_pda(w), instructions sysvar]` |
| instructions | 1 | 2 (precompile first) |
| data length prefix | threw above 127 bytes | `short_vec`, and the precompile instruction alone is 160 bytes |

Changes:

- **`@toon-protocol/settlement-digest` / `@toon-protocol/core` / `@toon-protocol/sdk`**:
  new `balanceProofMessageSolana(channelPda, nonce, transferredAmount)` — the
  48-byte message the program's Ed25519 precompile check reconstructs, and the
  only Solana balance proof that can be redeemed. `bigintToBytes8LE` and
  `SOLANA_BALANCE_PROOF_MESSAGE_SIZE` are exported alongside it.
- **`balanceProofHashSolana` is now deprecated** and used by the settlement path
  nowhere. It remains exported (it shipped in core/sdk 3.0.0) with its golden
  vectors intact, documented as not verifiable on chain.
- **`verifyEd25519Signature`** verifies the program's message. A claim signed
  over the legacy digest is now `SIGNER_MISMATCH` — so `buildSettlementTx`
  refuses to hand back a Solana bundle the chain would reject instead of
  reporting success.
- **`buildSolanaSettlementTx`** compiles a real two-instruction legacy Message
  (Ed25519 precompile, then `ClaimFromChannel`) with the program's account order
  and privileges, proper `short_vec` lengths, and a duplicate-account guard.
- **New `patchSolanaRecentBlockhash(messageBytes, blockhash)`** (exported from the
  sdk root): the bundle carries an all-zero blockhash placeholder, and patching it
  is the submitter's one remaining step before signing with the recipient key.

Proven, not asserted: `packages/sdk/tests/integration/solana-claim-redeem.integration.test.ts`
boots a `solana-test-validator` with the real program (vendored, hash-asserted)
and a real channel PDA, redeems a claim through `buildSettlementTx`, and asserts
the on-chain `nonce_a` / `transferred_amount_a` moved — plus the mirror image: a
legacy-digest claim is refused by the builder and, if forced, by the chain.

**Signers must move in lockstep.** Any Solana balance-proof signer — today
`@toon-protocol/swap`'s `SolanaPaymentChannelSigner` — must sign
`balanceProofMessageSolana` for its claims to verify here and redeem on chain.

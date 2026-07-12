---
'@toon-protocol/sdk': minor
---

rfc-0039 stream receipts (issue #84, rolling-swap spec §7.2): per-fulfill signed proof of delivered-B.

Maker side (`createSwapHandler`): when the sender advertises a session via the rumor's new `stream-nonce` tag, every ACCEPT's metadata gains an additive `receipt` object — `{v, streamNonce, seq, cumulativeDelivered, rate, rateTimestamp, sig}` — BIP-340-signed over a canonical length-prefixed encoding with the maker identity key by default (new `receiptSecretKey` config to provision a dedicated signer; new `receiptSessions` store seam for persistence alongside claims). Rejected packets never advance the session. Legacy senders (no tag) get the pre-existing metadata shape verbatim.

Sender side (`streamSwap`): a per-stream 16-byte `streamNonce` is generated and sent on every rumor; each fulfilled packet's receipt is verified (signature vs `receiptPubkey` ?? `swapPubkey`, session match, monotone cumulative totals, duplicate-seq/fork detection, tape-consistency) BEFORE its claim accumulates. Verified receipts surface on `AccumulatedClaim.receipt`, `PacketProgress.receipt`, and the always-present `StreamSwapResult.receipts` chain (`{streamNonce, receipts, latest, totalDelivered, holes}` — present on abort too, covering what filled). A present-but-invalid receipt is a loud `RECEIPT_INVALID` rejection that halts the stream (`abortReason: 'receipt-invalid'`); receipt-less legacy makers degrade gracefully unless the new `requireReceipts` param is set (`RECEIPT_MISSING` + halt). `serializeReceiptChain()` exports the chain as a versioned, third-party re-verifiable audit/dispute artifact.

New module `stream-receipts.ts` exported from the root and `/swap` entry points: `signStreamReceipt`, `verifyStreamReceipt`, `parseStreamReceipt`, `encodeReceiptSigningPayload`, `serializeReceiptChain`, `isValidStreamNonce`, `issueSessionReceipt`, `ReceiptChainTracker`, `BoundedReceiptSessions`, plus types.

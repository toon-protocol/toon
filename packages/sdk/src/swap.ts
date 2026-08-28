/**
 * Lean swap-only entry point.
 *
 * Re-exports the gift-wrap and stream-receipt primitives the ROLLING swap
 * path is built from, WITHOUT the Arweave/DVM modules (which pull in
 * `@ardrive/turbo-sdk` + `arweave`). Consumers that only need swaps import
 * from `@toon-protocol/sdk/swap` so a downstream bundler does not drag the
 * whole DVM surface (~19 MB) into their build.
 *
 * toon#211 (ADR 0003 stage 7) withdrew the legacy `streamSwap()` /
 * `streamSwapControlled()` sender that used to be re-exported here. A maker
 * is now run with `startSwapNode` from `@toon-protocol/swap`.
 *
 * Everything here is also exported from the package root (`@toon-protocol/sdk`);
 * this module just narrows the import graph.
 */
// toon#210: `AccumulatedClaim` is a settlement type shared by the rolling
// path; it moved out of the legacy `stream-swap.ts` sender (withdrawn by
// toon#211) but is exported under the same name.
export type { AccumulatedClaim } from './settlement/accumulated-claim.js';
export { wrapSwapPacketToToon, decryptFulfillClaim } from './gift-wrap.js';
// rfc-0039 stream receipts (issue #84): sender-side verification + the
// serialized audit artifact, plus the maker-side issuance helpers.
export {
  signStreamReceipt,
  verifyStreamReceipt,
  parseStreamReceipt,
  encodeReceiptSigningPayload,
  serializeReceiptChain,
  isValidStreamNonce,
  issueSessionReceipt,
  ReceiptChainTracker,
  BoundedReceiptSessions,
  STREAM_RECEIPT_VERSION,
} from './stream-receipts.js';
export type {
  StreamReceipt,
  StreamReceiptFields,
  StreamReceiptChain,
  ReceiptAddResult,
  ReceiptSessionState,
  ReceiptSessionStoreLike,
} from './stream-receipts.js';

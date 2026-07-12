/**
 * Lean swap-only entry point.
 *
 * Re-exports the sender-side swap streaming surface WITHOUT the Arweave/DVM
 * modules (which pull in `@ardrive/turbo-sdk` + `arweave`). Consumers that only
 * need swaps — e.g. `@toon-protocol/client-mcp`'s `toon_swap` — import from
 * `@toon-protocol/sdk/swap` so a downstream bundler does not drag the whole DVM
 * surface (~19 MB) into their build.
 *
 * Everything here is also exported from the package root (`@toon-protocol/sdk`);
 * this module just narrows the import graph.
 */
export { streamSwap, streamSwapControlled } from './stream-swap.js';
export type {
  StreamSwapParams,
  StreamSwapResult,
  StreamSwapClient,
  StreamSwapController,
  AccumulatedClaim,
  PacketProgress,
  RateMonitorCallback,
} from './stream-swap.js';
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

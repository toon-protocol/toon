---
'@toon-protocol/sdk': major
---

Withdraw `createSwapHandler` and `streamSwap` / `streamSwapControlled` — the maker- and
sender-side implementations of the legacy claim-in-FULFILL swap protocol (toon#211, ADR 0003
stage 7).

TOON supports the **rolling** swap protocol only, per
[ADR 0003](https://github.com/toon-protocol/toon-meta/blob/main/docs/adr/0003-the-rolling-swap-is-the-only-swap.md).
Legacy — the all-zero-condition, kind:20032 gift-wrap protocol where the maker returns a signed
balance proof inside the FULFILL `data` — is now removed from every repo in the fleet. Nothing in
the organization imports these symbols any more: the rolling maker stopped wiring
`createSwapHandler` (toon-protocol/swap#154), `@toon-protocol/swap` stopped re-exporting it
(toon-protocol/swap#155), and the client stopped sending legacy packets
(toon-protocol/toon-client#598).

**Removed** (no deprecation shim — see ADR 0003's rejected options):

- `createSwapHandler`, `findSwapPair`, `SWAP_HANDLER_REJECT_CODES`, `SWAP_HANDLER_REJECT_MESSAGES`
  and their types (`CreateSwapHandlerConfig`, `ClaimIssuer`, `SwapHandlerLogger`, `RateQuote`,
  `SwapHandlerFailure`, `SwapHandlerFailureContext`, `SwapHandlerFailureMapper`,
  `SwapHandlerFailureStage`, `SwapHandlerRejection`, `SwapHandlerRejectResponse`).
- `streamSwap`, `streamSwapControlled`, `StreamSwapError` and their types (`StreamSwapParams`,
  `StreamSwapResult`, `StreamSwapClient`, `StreamSwapController`, `PacketProgress`,
  `RateMonitorCallback`).
- The internal `__streamSwapTesting` testing surface.
- `packages/sdk/scripts/swap.mjs` and `scripts/swap-mina.mjs` (legacy one-shot demo scripts).

**Unchanged** — still exported from `@toon-protocol/sdk` (and `@toon-protocol/sdk/swap` where
applicable), because settlement and the rolling swap engine depend on them regardless of protocol:
`applyRate` / `ApplyRateParams`, `SwapHandlerError`, `AccumulatedClaim`, `IssueClaimParams` /
`IssueClaimResult`, `wrapSwapPacketToToon`, `unwrapSwapPacket`, `buildSettlementTx`,
`verifyAccumulatedClaim`, the adaptive δ/W controller, and the rfc-0039 stream-receipt primitives.

**Migration:** a maker is now run with `startSwapNode` from `@toon-protocol/swap`. There is no
drop-in replacement for `streamSwap()` inside `@toon-protocol/sdk` — sending a rolling swap goes
through `@toon-protocol/swap`'s / `@toon-protocol/client`'s rolling RFQ client. `@toon-protocol/sdk`
is public and a legacy maker or sender built on these symbols may exist outside the fleet; this
note is the entire mitigation, since third-party integrations cannot be observed or migrated
directly.

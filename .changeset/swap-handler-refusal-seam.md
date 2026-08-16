---
'@toon-protocol/sdk': minor
---

fix(sdk): stop swallowing swap-handler failures — surface the error and let the caller classify the reject

`createSwapHandler` recognised exactly one failure condition
(`INSUFFICIENT_INVENTORY` → `T04 Insufficient liquidity`) and collapsed
everything else into `logger.error({ event: 'swap_handler.issuer_failed' })` +
`ctx.reject('T00', 'Internal error')`. The thrown value never left the
handler: only its `message` reached the (by default no-op) logger, and nothing
at all reached the caller. Live on devnet the maker refused every swap with a
bare `T00 Internal error` while the throw site had a perfectly actionable
`0x0124a370…: 1000 unredeemed` — a multi-hour diagnosis for a mundane cause.
`swap_handler.encrypt_failed` was worse: a second, indistinguishable
`T00 Internal error`, which the downstream consumer (swap#137) could only
*infer* by observing that a blanket T00 had arrived after a claim was
successfully issued.

- New optional `CreateSwapHandlerConfig.onFailure` hook. Before rejecting
  because something threw — `rateProvider`, `applyRate`, `claimIssuer.issueClaim`,
  or `encryptFulfillClaim` — the handler calls it with a `SwapHandlerFailure`
  carrying the thrown value VERBATIM (`code`, `details`, `cause`, stack all
  intact), the extracted `message`, packet context (`pair`, `senderPubkey`,
  `chainRecipient`, `sourceAmount`, `rate`, `targetAmount`, `claimIssued`,
  `claimId`), and the `defaultRejection` it would otherwise emit. Returning a
  `SwapHandlerRejection` replaces the reject's `code`/`message` and may attach
  `data`, `rejectReason`, and `metadata`; returning `undefined` keeps the
  default. The hook cannot break the handler — a throw or a malformed return
  logs (`swap_handler.on_failure_threw` /
  `swap_handler.on_failure_invalid_rejection`) and falls back to the default.
- The `encrypt` stage no longer ends the error's life. It reports
  `claimIssued: true` (value committed, claim stranded), so a consumer can
  classify it outright instead of inferring it.
- Every refusal log line now also carries `err` (the thrown value itself, for
  a pino-style serializer), `code` when present, `stage`, and the
  `rejectCode`/`rejectMessage` actually going on the wire. The pre-existing
  `event` names and the `error` (message) field are unchanged.
- New exported types: `SwapHandlerFailure`, `SwapHandlerFailureContext`,
  `SwapHandlerFailureMapper`, `SwapHandlerFailureStage`,
  `SwapHandlerRejection`, `SwapHandlerRejectResponse`.

Backward compatible: with no `onFailure`, every code and message on every path
is byte-identical to before, `INSUFFICIENT_INVENTORY` included.

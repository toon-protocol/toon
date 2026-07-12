---
'@toon-protocol/sdk': minor
---

Quote-tape plumbing + `minExchangeRate` hard floor in `streamSwap` (issue #82, rolling-swap spec §5/§7.1).

Maker side (`createSwapHandler`): every FULFILL accept-metadata now carries the
resolved per-packet rate `R_i` (`rate`, decimal string) and its quote timestamp
(`rateTimestamp`, unix ms) — the quote tape. `rateProvider` may now return
either the legacy decimal string (timestamp stamped at resolution) or a
`RateQuote` `{ rate, rateTimestamp }` so the rate source's own tick time
travels on the tape. Additive and backward compatible.

Sender side (`streamSwap` / `streamSwapControlled`):

- `decodeFulfillMetadata` parses the tape; a present-but-malformed or partial
  tape entry is a loud per-packet `FULFILL_DECODE_FAILED`, never a silent drop.
- New `minExchangeRate` param (rfc-0029 semantics): a hard, per-packet,
  pre-accept floor. When set, the tape becomes required, and a packet whose
  tape rate is below the floor OR whose delivered `targetAmount` is below
  `applyRate(sourceAmount, minExchangeRate)` is recorded as a `BELOW_FLOOR`
  rejection (never accumulated into `claims[]`) and the stream halts with
  `abortReason: 'below-floor'`. The floor is independent of — and never
  relaxed by — the soft `rateDeviationThreshold` monitor or any
  callback/controller signal.
- `PacketProgress` and `AccumulatedClaim` gain optional `rate`/`rateTimestamp`
  fields so `onPacket` consumers (the adaptive controller) can read the tape
  per fulfilled packet, in order.

When the new params are omitted and the maker emits no tape, behavior is
unchanged.

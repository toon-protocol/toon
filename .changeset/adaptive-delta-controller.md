---
'@toon-protocol/sdk': minor
---

Adaptive δ/W controller for rolling swaps (issue #83, rolling-swap spec §6),
persisted per (chain, maker, pair).

New module `adaptive-controller`:

- `AdaptiveDeltaController` (built via async `AdaptiveDeltaController.create`)
  manages the two rolling-swap knobs from measured, untrusted inputs: δ
  (packet size, bounds per-packet pick-off risk) and W (in-flight window,
  bounds timing risk and the worst-case exposure δ·W).
- The cap: `delta_cap = ε/(v·τ)` recomputed per packet — `v` is an EWMA of
  `abs(ΔR)/R` per second read off the issue-#82 quote tape, `τ` an EWMA of
  observed RTTs, and ε is denominated as a fraction of the maker's advertised
  half-spread (default `0.5 × halfSpread`), never an absolute rate. An
  absolute `maxPacketAmount` (maker maxAmount) cap binds independently.
- Asymmetric, one-knob-per-step ramp: multiplicative shrink on stale-rate
  rejects / other rejects / realized slip > ε (`δ ← max(δ_min, δ/2)`) and on
  timeouts (`W ← max(1, ⌈W/2⌉)`); additive widen after K = 16 consecutive
  clean fulfills (`δ ← δ + δ_0` or `W ← W + 1`, alternating). Cold start is
  small on both knobs (`δ_0 = min(delta_cap, notional/256, maxAmount)`,
  `W_0 = 1`) with a multiplicative slow-start until the first-ever loss.
- State (`{delta, W, vEwma, tauEwma, cleanStreak, everShrunk, lastWidened,
  updatedAt}`) persists per `${chain}:${makerPubkey}:${from}:${to}` through a
  pluggable `SwapControllerStateStore` (SDK stays isomorphic):
  `InMemorySwapControllerStateStore` (default) or the Node-only
  `JsonFileSwapControllerStateStore` (atomic JSON-file map, the
  `ChannelStore` pattern), so ramp/trust survives across swaps.

`streamSwap` / `streamSwapControlled` wiring: new `controller` param
(exactly one of `packetCount`, `packetAmounts`, or `controller`). In
controller mode the static even split is replaced by per-packet
`controller.nextDelta(remaining)` sizing, up to `controller.window` packets
are kept in flight concurrently, and every packet resolution feeds back a
`PacketObservation` (resolution class, RTT, tape entry, realized amounts).
The `minExchangeRate` floor is enforced in shared code BEFORE the controller
observes anything — controller state can only tighten/loosen δ and W and can
never relax the floor. Legacy paths (no `controller`) are unchanged.

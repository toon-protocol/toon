---
'@toon-protocol/core': patch
'@toon-protocol/sdk': patch
---

fix: use the bare `evm:<chainId>` settlement identifier on the wire (toon#165)

Settlement negotiation intersects the two sides' `supportedChains` sets, and the
live fleet's kind:10032 announce plus the connector's x402 greeting both use the
bare `evm:<numeric chainId>` form (e.g. `evm:84532`). Two places still emitted an
extra family segment (`evm:base:84532`), which intersected with nothing and made
EVM silently drop out of negotiation, falling through to Solana:

- **core** — `resolveClientNetwork` now emits `evm:<chainId>` for the preset
  client's `supportedChains` / `chainRpcUrls` / `preferredTokens` /
  `tokenNetworks` keys. `BootstrapService` and the discovery tracker log the
  negotiated intersection so an empty one is diagnosable instead of silent.
- **sdk** — `createNode`'s auto-populated `settlementInfo` (which flows into
  `BootstrapService` and the kind:10032 announce) now uses the same bare form.
  It previously announced `evm:base:<chainId>` while the connector's own
  `chainProviders` entry in the same function already used `evm:<chainId>`.
  The derivation is extracted as `buildDefaultSettlementInfo` and pinned by
  tests across every chain preset.

No config or wire format change is required of callers that already passed an
explicit `settlementInfo`; only the auto-populated default changed.

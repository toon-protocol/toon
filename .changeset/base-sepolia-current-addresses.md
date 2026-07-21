---
"@toon-protocol/core": patch
---

Correct the `base-sepolia` (evm:84532) chain preset to the current public
deployment. `CHAIN_PRESETS['base-sepolia']` still carried the retired e2e
deployment — an 18-decimal mock USDC (`0xac806…`), old TokenNetwork
(`0x47616F4b…`) and registry (`0xb9516c…`) — so any consumer that fell back to
the preset (when a live announce omitted `preferredTokens`/`tokenNetworks` for
`evm:84532`) resolved the wrong token at the wrong decimals and would settle
payment channels against a dead contract. Updated to the post-2026-07-19
public-chain cutover addresses (USDC `0x49beE1…` 6-decimal, TokenNetwork
`0x1E95493f…`, registry `0xcC9079ad…`; rpcUrl `https://sepolia.base.org`
unchanged). Source of truth: toon-meta `docs/deployment.md`.

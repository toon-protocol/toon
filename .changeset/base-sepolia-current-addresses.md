---
"@toon-protocol/core": patch
---

Correct the stale devnet/testnet chain presets to the current public deployment
(source of truth: toon-meta `docs/deployment.md`, post-2026-07-19 public-chain
cutover). Consumers that fell back to these presets — when a live announce
omitted `preferredTokens`/`tokenNetworks` — resolved retired tokens/contracts
and would settle against dead addresses.

- **Base Sepolia (`evm:84532`)** `CHAIN_PRESETS['base-sepolia']` carried the
  retired e2e deployment (18-decimal USDC `0xac806…`, old TokenNetwork
  `0x47616F4b…`, registry `0xb9516c…`) → wrong token at wrong decimals. Updated
  to USDC `0x49beE1…` (6-decimal), TokenNetwork `0x1E95493f…`, registry
  `0xcC9079ad…` (rpcUrl `https://sepolia.base.org` unchanged).
- **Solana devnet** the deployed-devnet profile carried the pre-cutover
  self-hosted-validator mint `9FtYCX…` (mint authority is NOT the faucet
  treasury) and program `EdJxYPD…`. Updated to the live mint
  `xyc5J8Mg…` (authority = faucet treasury `AEPoA5xT…`) and program
  `2aEVJ8k…`.

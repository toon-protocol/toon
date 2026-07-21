---
'@toon-protocol/core': patch
---

Correct the devnet Mina settlement preset and the Base Sepolia RPC.

- `CHAIN_PRESETS['base-sepolia'].rpcUrl`: `https://sepolia.base.org` →
  `https://base-sepolia-rpc.publicnode.com`. The old load balancer serves stale
  reads, so `openChannel`→`setTotalDeposit` fails with `InvalidChannelState`
  (0xf806e9d9); publicnode is the working devnet/testnet default.
- `MINA_DEPLOYED_DEVNET`: update the zkApp to the current deployed
  PaymentChannel (`B62qmgPhv2Xo…`, retiring `B62qrH1As4…`) and add the
  settlement `tokenId` (`9497…`). The channels are denominated in a custom USDC
  token, so the tokenId is required to read the token balance and open channels
  against the right token. It now flows through `MinaTierCfg`,
  `resolveClientNetwork().minaChannel.tokenId`, and the node's Mina
  `chainProviders` entry.

Source of truth: toon-meta `docs/deployment.md`. This makes the baked preset the
drift-proof fallback a fresh client resolves before any connector redeploy; the
kind:10032 announce still overrides these fields when present.

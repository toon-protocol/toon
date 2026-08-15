---
"@toon-protocol/core": patch
---

fix(core): promote the deployed Solana mainnet program id into the `solana-mainnet` preset

`SOLANA_CHAIN_PRESETS['solana-mainnet']` (and thus `resolveSolanaChainConfig('solana-mainnet')`)
shipped `programId: ''`, pending a mainnet deploy of the TOON payment-channel program
(connector#834). That program is now live on Solana mainnet-beta at
`8e7BhzydH1EqL486tw6Lp99BXviH3i5JN8qNpMSNmHj3` (deployed slot 439316400, verified against a
local `cargo build-sbf` build of `connector@main` — see toon#198 / connector#971), so the preset
now carries it. `tokenMint` (Circle's native USDC) is unchanged.

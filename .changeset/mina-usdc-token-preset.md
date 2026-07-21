---
"@toon-protocol/core": patch
---

Default the Mina settlement-USDC `tokenId` in `resolveClientNetwork` (testnet/devnet)

The client network preset defaulted the EVM USDC contract and the Solana USDC
mint, but not the Mina equivalent — so a wallet view had no way to read the Mina
USDC balance (which needs the token's derived `tokenId`, a Field). Add
`minaChannel.tokenId` to the devnet/testnet preset (`TokenId.derive` of the
deployed USDC token owner), the Mina analogue of `solanaChannel.tokenMint`.
Mainnet stays unset (no token deployed).

# sdk live-exercise scripts

Manual, one-shot swap-swap scripts for exercising a **running** `toon-clientd`
daemon against a live TOON node (issue #197). They are NOT part of the build or
test suite. Each builds the NIP-59 gift-wrapped kind:20032 swap rumor with the
SDK's `wrapSwapPacketToToon`, then POSTs it to the daemon `/swap` endpoint's
`toonData` passthrough (`http://127.0.0.1:8787`) so the daemon signs the
source-asset claim against the open apex channel. The FULFILL's NIP-44 target
claim is decrypted with `decryptFulfillClaim`.

> Now that `toon_swap` is wired to `streamSwap` (#246), the daemon builds the
> gift wrap itself — these scripts predate that and remain useful as a
> low-level, dependency-light way to drive a single swap and inspect the raw
> FULFILL metadata.

Prereq: a configured + running daemon, `ready`, with the swap routed via
`apexChildPeers` (#242). Build the SDK first (`pnpm --filter @toon-protocol/sdk
build`) — the scripts import from `../dist`.

| Script | Pair |
| --- | --- |
| `swap-swap.mjs` | EVM USDC (`evm:base:84532`) → Solana USDC (`solana:devnet`) |
| `swap-swap-mina.mjs` | EVM USDC (`evm:base:84532`) → MINA (`mina:devnet`) — first run triggers the swap's ~30 s `PaymentChannel.compile()`, so it retries once |

Run from this package dir, e.g.:

```bash
node scripts/swap-swap.mjs
node scripts/swap-swap-mina.mjs
```

Edit the constants at the top (`SWAP_PUBKEY`, `CHAIN_RECIPIENT`, `pair`) to match
the target node's swap.

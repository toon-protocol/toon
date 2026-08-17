# Vendored Solana program fixture

`payment_channel.so` is the **real** native payment-channel program the SDK's
Solana settlement path targets. `solana-claim-redeem.integration.test.ts` loads
it into a local `solana-test-validator` at genesis and redeems a real claim
against it, which is the only check that can catch an encoding the program
rejects (toon#214 shipped one for months: an Anchor-style discriminator, a
reversed payload, and the balance-proof signature stuffed into the program's own
instruction data instead of an Ed25519 precompile instruction).

| | |
| --- | --- |
| Source | [`toon-protocol/connector`](https://github.com/toon-protocol/connector) → `packages/solana-program/` (native Rust, **not** Anchor) |
| Source commit | `e9bfadad717e66ad9f6b99a929afed1514adce57` (tree `f193bd899e195c623d0c942cfaaba0d1652a8a21`) |
| Built with | `cargo build-sbf --tools-version v1.52` — the pin connector's CI and `Makefile` use |
| Size | 109,416 bytes |
| sha256 | `b15e3c808bda581457110193dcdecd060d22c0697b40ce245b4f9188c7497600` |

The test asserts both size and hash before booting, so a truncated or
silently-swapped blob fails loudly rather than yielding a validator whose program
rejects everything.

This is a **byte-identical copy** of
`toon-protocol/swap` → `packages/swap/tests/e2e/fixtures/solana/payment_channel.so`
(swap#160/#162), loaded at the same `LOCAL_TEST_PROGRAM_ID`
(`HY4AYFNe5Vg5BkEwAURNsGY3uFAvGMNpAQPRtgoasJiR`) connector's own Rust harness
uses (`crates/connector-settlement-solana/src/test_support.rs`). The program has
no `declare_id!` — it reads `program_id` from the entrypoint and derives its PDAs
from it — so one shared local id means one set of PDAs across all three repos'
tests. Keep the three copies in step: if you refresh one, refresh the others and
update the size/hash in each repo's own assertion.

## Regenerating

```sh
cd /path/to/connector/packages/solana-program
cargo build-sbf --tools-version v1.52
cp ../../target/deploy/payment_channel.so \
   /path/to/toon/packages/sdk/tests/integration/fixtures/solana/payment_channel.so
sha256sum .../payment_channel.so   # update the table above AND the test's constants
```

Vendoring (rather than building in CI, or dumping the program off public devnet)
keeps this test toolchain-free, network-free and byte-identical on every run; the
cost is remembering to refresh 109 KB when the program changes. The canonical
account layout it writes — the 178-byte `ChannelState` with the ASCII `pchannel`
discriminator — is `packages/solana-program/src/state.rs` at that commit.

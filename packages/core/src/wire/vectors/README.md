# Vendored wire vectors

`wire-vectors.json` is a **verbatim copy** of `vectors/wire-vectors.json` on
[`toon-protocol/connector`](https://github.com/toon-protocol/connector) `main`.
It is generated there (`cargo run -p connector-vectors --bin generate-vectors`),
never hand-written, and it is the cross-repo contract for the client-edge
termination wire ([connector ADR
0021](https://github.com/toon-protocol/connector/blob/main/docs/adr/0021-vectors-are-normative-prose-is-not.md)):
reproducing these bytes is what conformance means for `@toon-protocol/core/wire`.

`wire-vectors.provenance.json` records the connector commit it came from and the
SHA-256 of the copy. `src/wire/wire-vectors.test.ts` replays **three** of the
file's six sections — the three this package implements: `envelope` against
`src/wire/envelope.ts`, and `giftwrap` and `fulfilment` against
`src/wire/giftwrap.ts`. The other three are carried but deliberately not
replayed here — see [Sections](#sections).

Both the file and this directory arrived with `announceViaIlp`'s sealed-wire
fix (toon#143), ported from `toon-protocol/toon-client`'s
`packages/client/src/wire/vectors/`. That copy replays five sections, because
`toon-client` also carries the EIP-712 signing surface (`src/signing/evm-signer.ts`)
the other two are evidence against; `core` does not.

## Why vendored, and not fetched or submoduled

|               |                                                                                                                                                                                                                                                                                                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Integrity** | `wire-vectors.test.ts` hashes the vendored file every run and fails if it does not match `provenance.sha256`. Hand-editing the copy to make a failing replay pass is therefore not possible without also editing the provenance, which shows up in review as exactly what it is.                                                                                  |
| **Coverage**  | `WIRE_VECTOR_SECTIONS` in `load.ts` is a closed list, and the harness fails if the vendored file carries a section that is not in it, or one that is in neither `sectionsReplayed` nor `sectionsPresentNotYetReplayed` in the provenance. A section the connector adds therefore breaks the build until someone decides, in writing, what this repo does with it. |

The rejected alternatives:

- **Fetched at test time** — makes `pnpm test` require the network and makes a
  connector-side change break this repo's CI on an unrelated PR, with no commit
  here recording what changed. Conformance would also be untestable offline.
- **Git submodule** — pulls the entire Rust connector repo (and its
  toolchain-shaped tree) into every `pnpm install` for one 7 KB JSON file, and
  submodule pointer bumps are a notoriously easy thing to merge without reading.

Vendoring keeps the bytes in this repo's history — so `git log` on this file is
the record of every wire change `core` has adopted — while the integrity check
above removes the one thing vendoring costs.

> **No automated drift check yet.** `toon-client` has a `vectors:refresh` script
> and a scheduled drift workflow; this repo has neither, so nothing here notices
> when the connector's `main` copy moves. Until one is added, drift is caught
> only by someone refreshing by hand.

## Refreshing

Refresh when — and only when — you are **deliberately adopting a wire change**:
you are landing a `core` change against a connector commit that moved these
bytes. It is never a fix for a failing replay on its own; it is the act of
accepting a new contract, and the diff it produces _is_ the wire change, so it
belongs in a commit of its own with that framing.

There is no refresh script in this repo. By hand:

1. Overwrite `wire-vectors.json` with
   `https://raw.githubusercontent.com/toon-protocol/connector/<ref>/vectors/wire-vectors.json`.
2. Update `wire-vectors.provenance.json`'s `connectorCommit`,
   `connectorCommitDate`, `connectorCommitSubject`, `schemaVersion` and
   `sha256` (`shasum -a 256 wire-vectors.json`) to match. Leave the two
   `sections*` lists alone unless the harness itself changed — they describe
   this repo, not the source file.
3. Run `pnpm --filter @toon-protocol/core test`. A failing replay after a
   refresh means the wire changed and `core` has not caught up — that is the
   signal, not a flake.

Commit `wire-vectors.json` and `wire-vectors.provenance.json` together.

## Sections

`schema_version` is `1`. The file carries six sections; this repo replays
**three** of them:

- `envelope` — **replayed** against `src/wire/envelope.ts`: 5 valid round-trips
  and 8 rejection cases.
- `giftwrap` — **replayed** against `src/wire/giftwrap.ts`: the pinned
  `request_wrap_hex` and `response_wrap_hex` are reproduced byte-for-byte from
  each case's pinned ephemeral secret, shared secret and nonces, and re-opened
  with the fixture identity secret. The HKDF `info` strings and the wrap framing
  are recorded in `src/wire/giftwrap.ts`'s module comment, cited to
  `crates/connector-signer/src/giftwrap.rs`, and are also documented in the
  connector's own `vectors/README.md` (connector#588).
- `fulfilment` — **replayed** against `src/wire/giftwrap.ts`: both the matching
  and the non-matching case, including that the condition a sender mints is
  `sha256` of the derived fulfilment
  (`crates/connector-domain/src/condition.rs`'s `derive_condition`).
- `claim` — **carried, NOT replayed** (connector#588 added it): the EIP-712
  `BalanceProof` of [connector ADR
  0024](https://github.com/toon-protocol/connector/blob/main/docs/adr/0024-peer-wire-claims-sign-the-eip-712-balance-proof.md).
  `core` signs no balance proofs — the EIP-712 signer lives in `toon-client`
  (`src/signing/evm-signer.ts`), which replays this section against it — so
  there is nothing here for these bytes to be conformance evidence against.
- `peer_carriage` — **carried, NOT replayed** (connector#758): the
  connector-to-connector peer wire (`docs/protocol/peer-carriage-spec.md` §10 on
  the connector). No client SDK is a peer connector — it never speaks BTP
  claim-ack/flush carriage to another connector — so there is nothing in this
  repo for these 20 items to be conformance evidence against either.
- `channel_control_declaration` — **carried, NOT replayed** (connector#795 added
  it): the BTP auth greeting's `channelId`/`expires`/`signature` declaration.
  Client-edge wire, but it is `toon-client`'s BTP greeting that sends it and
  `EvmSigner.signClaimStateChallenge` that signs it; `core` has no counterpart.

`loadWireVectors()` in `load.ts` exposes all six, so replaying one this repo
grows the surface for is a new `describe` block plus a move between the two
provenance lists — not a restructure. The **not replayed** label is enforced,
not decorative: the harness asserts that `sectionsReplayed` and
`sectionsPresentNotYetReplayed` together partition exactly the sections the
vendored file carries, so neither list can quietly fall out of step with what
`wire-vectors.test.ts` actually runs.

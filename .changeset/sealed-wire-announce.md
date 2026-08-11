---
"@toon-protocol/core": minor
---

fix(core): seal `BootstrapService.announceViaIlp`'s packet and carry a real execution condition

`BootstrapService.announceViaIlp` sent its announce PREPARE with no
`executionCondition` and a plaintext base64 TOON payload, which a Rust
connector refuses outright (`F01 prepare carries no execution condition`;
toon#143).

- `@toon-protocol/core` gains a new `./wire` subpath export carrying the
  sealed-wire primitives (`sealExchange`, `readExchangeOutcome`,
  `deriveFulfillment`, `deriveCondition`, the gift-wrap seal/open pair, and
  the OER envelope codec), ported from `@toon-protocol/client`'s
  `src/wire/` together with its committed cross-repo vectors. `core` gains
  `@noble/curves` and `@noble/ciphers` as direct dependencies; it does not
  depend on `@toon-protocol/client`.
- `IlpClient.sendIlpPacket`/`sendIlpPacketWithClaim` accept an optional
  base64-encoded `executionCondition`, forwarded verbatim by every in-repo
  transport (`direct-ilp-client`, `http-ilp-client`, `ilp-client`,
  `direct-bls-client`).
- A new `ConnectorEdgeLookup` port (`getIdentity`/`getRoutePrice`) lets a
  caller supply the terminating connector's identity and route price;
  `announceViaIlp` seals its packet to that identity via one `sealExchange`
  call on both the claim and no-claim branches, and asks for the amount
  (ADR 0020) instead of computing it as bytes × rate. Without a
  `connectorEdgeLookup`, the announce phase is skipped rather than sending
  an unsealed packet.
- `BootstrapServiceConfig.basePricePerByte` is deprecated: it no longer
  prices the announce path by multiplying against the payload's byte
  length; if set, it is used verbatim as an explicit amount override
  instead of asking for the route price.

---
'@toon-protocol/core': major
---

Core shrinks to what its callers use: the TOON codec (`./toon`), `./nip34`, `base58Encode` / `base58Decode`, and the kind 5094 blob storage request builder and parser. Everything else is removed.

**Removed**

- The `./wire` subpath export and `wire/`.
- `bootstrap/` (`BootstrapService`, the ILP, channel and connector-admin clients, attestation bootstrap and verifier), `discovery/` (`NostrPeerDiscovery`, `GenesisPeerLoader`, `ArDrivePeerRegistry`, `SocialPeerDiscovery`, `SeedRelayDiscovery`, `genesis-peers.json`), `address/` (`deriveChildAddress`, prefix handshake, `AddressRegistry`, ILP address validation), `fee/` (`calculateRouteAmount`, `resolveRouteFees`), `x402/` (`buildIlpPrepare`), `chain/` (chain presets, network profiles, mock USDC), `compose.ts` (`createToonNode`, `EmbeddableConnectorLike` and the packet types), `utils/reject-code.ts`.
- `settlement/`: negotiation, balance-proof hashes and Mina key helpers. `base58Encode` / `base58Decode` stay and move to their own module.
- `build/` (`NixBuilder`, PCR reproducibility), `identity/` (`deriveFromKmsSeed`), `ui/` (UI coordinate helpers) and `createLogger`.
- Every event builder and parser except kind 5094: kind:10032 (`buildIlpPeerInfoEvent`, `parseIlpPeerInfo`, `validateChainId`, swap-pair validation), prefix claim and grant (10034, 10037), service discovery (10035), seed relay (10036), TEE attestation (10033) and `AttestedResultVerifier`, workflow (10040), swarm, reputation and web of trust, the NIP-90 job kinds, and NIP-40 expiration helpers.
- Constants: every kind constant but `BLOB_STORAGE_REQUEST_KIND` and `BLOB_STORAGE_RESULT_KIND`, `ILP_ROOT_PREFIX`, and the pet kinds.
- Types: `IlpPeerInfo`, `SwapPair`, `TeeAttestation`, `Subscription`, `OpenChannelParams`, `OpenChannelResult`, `ChannelState`, `ConnectorChannelClient`. Errors: `InvalidEventError`, `PeerDiscoveryError`.
- The optional `@toon-protocol/connector` peer dependency, and the dependencies only removed code used.

`@toon-protocol/sdk` and `@toon-protocol/settlement-digest` are no longer published from this repo. Their last published versions stay on npm.

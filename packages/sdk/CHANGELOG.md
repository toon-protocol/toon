# @toon-protocol/sdk

## 2.0.1

### Patch Changes

- Updated dependencies [9ff9751]
  - @toon-protocol/core@2.0.1

## 2.0.0

### Major Changes

- af4cd24: Rename all `mill` vocabulary to `swap` across public API and internals.
  - `MillSignerConfig` → `SwapSignerConfig`
  - `millSignerAddress` → `swapSignerAddress` (on `SettlementClaim`, `SettlementBundle`)
  - `millEphemeralPubkey` → `swapEphemeralPubkey`
  - `millPubkey` / `millIlpAddress` → `swapPubkey` / `swapIlpAddress` (on `StreamSwapParams`)
  - Error codes `MILL_SIGNER_MISMATCH` / `MILL_RECIPIENT_MISMATCH` → `SWAP_SIGNER_MISMATCH` / `SWAP_RECIPIENT_MISMATCH`
  - Scripts renamed: `mill-swap.mjs` → `swap.mjs`, `mill-swap-mina.mjs` → `swap-mina.mjs`

- cccae07: Rename DvmHealthResponse → StoreHealthResponse (and related types) to align with the dvm→store vocabulary cleanup (#45).

### Patch Changes

- 35fa7d3: Remove legacy `townhouse` term from code, comments, config, and docs.
- Updated dependencies [35fa7d3]
- Updated dependencies [af4cd24]
- Updated dependencies [2a5c243]
  - @toon-protocol/core@2.0.0

## 1.0.1

### Patch Changes

- Updated dependencies [816fc80]
  - @toon-protocol/core@1.6.0

## 1.0.0

### Major Changes

- 1b993f6: Drop Node 20 support: bump `engines.node` from `>=20` to `>=22` to match the CI test matrix (both `ci.yml` and `release.yml` now only run on Node 22). Consumers pinned to Node 20 are no longer covered by CI and should upgrade.

## 0.6.0

### Minor Changes

- 97af35e: Advertise ILP-over-HTTP in kind:10032 peer info. `IlpPeerInfo` gains optional `httpEndpoint` (RFC-0035 `POST /ilp` URL) and `supportsUpgrade` (whether the host accepts an HTTP `Upgrade` to BTP); `createNode` config gains matching `httpEndpoint` / `supportsUpgrade` options that are advertised in the node's announcement. Backward compatible — both fields are optional and omitted when unset.

  (Changeset retroactively added for #29, which merged without one.)

### Patch Changes

- 68a4e86: Re-publish `@toon-protocol/sdk` from the standalone `toon` repository. This repairs the unresolved `workspace:*` dependency on `@toon-protocol/core` that made `@toon-protocol/sdk@0.5.0` uninstallable for external consumers — changesets/pnpm rewrite the workspace protocol to the real version (`@toon-protocol/core@1.4.1`) at publish time.
- Updated dependencies [97af35e]
  - @toon-protocol/core@1.5.0

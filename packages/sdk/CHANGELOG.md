# @toon-protocol/sdk

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

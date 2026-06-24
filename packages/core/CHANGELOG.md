# @toon-protocol/core

## 1.6.0

### Minor Changes

- 816fc80: Add pure ui→kind:31036 coordinate and latest-addressable helpers. New exports: `parseUiCoordinate`, `buildUiCoordinate`, `getUiCoordinate`, `selectLatestAddressable`, the `UI_RENDERER_KIND` and `UI_TAG` constants, and the `UiCoordinate` type. All additive and side-effect free; no existing API changes.

  (Changeset retroactively added for #37, which merged without one.)

## 1.5.0

### Minor Changes

- 97af35e: Advertise ILP-over-HTTP in kind:10032 peer info. `IlpPeerInfo` gains optional `httpEndpoint` (RFC-0035 `POST /ilp` URL) and `supportsUpgrade` (whether the host accepts an HTTP `Upgrade` to BTP); `createNode` config gains matching `httpEndpoint` / `supportsUpgrade` options that are advertised in the node's announcement. Backward compatible — both fields are optional and omitted when unset.

  (Changeset retroactively added for #29, which merged without one.)

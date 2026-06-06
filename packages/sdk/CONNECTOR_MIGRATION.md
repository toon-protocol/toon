# `@toon-protocol/connector` Migration Guide

> **See also:** [`CONNECTOR_RELEASE_CONTRACT.md`](./CONNECTOR_RELEASE_CONTRACT.md) — the upstream `@toon-protocol/connector` release contract describing semver discipline for the `/admin/*` API surface, supply-chain signing, and digest-pinning strategy. This file (CONNECTOR_MIGRATION.md) is the runtime canary contract the SDK enforces; the contract file is the producer-side promise. Read both when bumping `@toon-protocol/connector` minor or major versions.

This document records the **API contract** that `@toon-protocol/sdk` depends on
from `@toon-protocol/connector`, and the breaking changes between versions.

The contract is enforced as a fast-feedback canary in two paired files:

- `packages/sdk/tests/integration/connector-contract.test.ts` — runtime
  behavioral assertions (vitest, esbuild-transpiled).
- `packages/sdk/tests/integration/connector-contract.types.ts` — type-only
  guards (tsc-checked via `tests/integration/tsconfig.json`). These guards
  catch shape changes that vitest's esbuild transform silently strips
  (`@ts-expect-error` directives, type-level field-presence checks).

The CI canary job (`connector-contract-canary`) runs both. When either
fails, this is the first place to look.

> **Why this exists.** The connector v2.3.0 → v3.3.2 upgrade silently broke
> 25 E2E tests across 5 packages. Those tests took minutes and required Docker
> infrastructure. A lightweight type + shape canary catches the same drift in
> under a second, before the heavy matrix runs. (Story 22.5.)

---

## Current Contract — `@toon-protocol/connector` >=3.3.2 (verified through 3.9.6)

The SDK consumes these connector APIs. Each entry below is asserted by the
contract canary.

> **Verified range:** No breaking changes to the consumed surface within 3.x.
> The contract holds from `>=3.3.2` through `3.9.6` — the current
> `DEFAULT_CONNECTOR_IMAGE` pin and npm dependency floor.
>
> **`3.9.6` — full non-EVM on-chain settle completed for BOTH Solana and Mina,
> all bug fixes (no contract change).** `3.9.6` itself is a connector-CI fix only
> (no runtime change vs `3.9.5`); the substantive settle-side fixes land across
> `3.9.4`/`3.9.5`:
>
> - **`3.9.4` (toon-protocol/connector#94)** — Solana `CLAIM_FROM_CHANNEL`
>   reconstructed the signed claim message incorrectly for the on-chain Ed25519
>   precompile verification, so a valid peer-signed Solana claim failed
>   signature verification on-chain. Fixed to reconstruct the exact signed
>   message the client produced.
> - **`3.9.4` (toon-protocol/connector#95)** — Mina `getChannelState` queried the
>   zkApp without `setActiveInstance(...)`, throwing an `account-not-found` /
>   instance error before the channel could be read. Fixed by setting the active
>   o1js instance prior to the on-chain read.
> - **`3.9.5` (toon-protocol/connector#98)** — the Mina balance-proof commitment
>   was compared against the **zkApp address** rather than the on-chain channel's
>   `balanceCommitment` field, so every Mina claim mismatched. Fixed to compare
>   the claim's Poseidon commitment against the on-chain `balanceCommitment`.
>   (Consumer note: the on-chain channel the opener initializes must carry a
>   `balanceCommitment` consistent with what the client signs.)
> - **`3.9.5` (toon-protocol/connector#99)** — Solana `CLAIM_FROM_CHANNEL`
>   required the fee-payer to be the claiming participant, so the connector could
>   not unilaterally redeem a peer-signed **inbound** claim. The fee-payer is now
>   decoupled from the claiming participant.
>
> Together these complete the `CLAIM_FROM_CHANNEL` + `SETTLE_CHANNEL` on-chain
> settle for both non-EVM chains, atop `3.9.3`/`3.9.2`/`3.9.1` below. The
> consumed SDK/admin surface is unchanged; the contract canary passes unmodified
> at the new digest.
>
> **`3.9.3` — Solana settle-executor channel-lookup fixed, a bug fix (not a
> contract change):** with the claim verified + stored and settlement triggered
> (the `settlementOptions.threshold` fix in townhouse #119), the settle executor
> looked up the on-chain external channel by an **EVM-derived `tokenId`**, which
> never matched the **programId-keyed** Solana external channel. It therefore
> treated the channel as absent and opened a **NEW** channel, and the resulting
> Solana settle transaction failed with `#5508010` (the fee-payer was not a
> `TransactionSendingSigner`) — blocking the full Solana on-chain settle
> (toon-protocol/connector#92). `3.9.3` resolves the external channel by the
> correct programId-keyed identifier so the existing on-chain Solana channel is
> found and the full settle (`CLAIM_FROM_CHANNEL` + `SETTLE_CHANNEL`) executes.
> The consumed SDK/admin surface is unchanged; the contract canary passes
> unmodified at the new digest.
>
> **`3.9.2` — Mina settlement-side proof encoding fixed, a bug fix (not a
> contract change):** the settlement executor decoded the on-chain Mina
> payment-channel `proof` with `JSON.parse(proof)`, which threw when the proof
> arrived base64-encoded rather than as a raw JSON string — surfacing as
> `mina_claim_verification_failed` and blocking the Mina publish→settle loop on
> the settle side (toon-protocol/connector#90). `3.9.2` normalizes the proof
> encoding so a Mina claim that passes inbound validation can verify through to
> on-chain settle. Builds on `3.9.1`'s dynamic-peer settlement-chain resolution
> (toon-protocol/connector#88), which lets the `SettlementExecutor` resolve the
> settlement chain for dynamic anonymous HS peers. The consumed SDK/admin surface
> is unchanged; the contract canary passes unmodified at the new digest.
>
> **`3.9.1` — inbound claim validation now dispatches by blockchain type, a
> bug fix (not a contract change):** `validateClaimMessage` switches on
> `claim.blockchain` and routes to `validateEVMClaim` / `validateSolanaClaim` /
> `validateMinaClaim`. In `3.9.0` the EVM validator ran unconditionally, so a
> Solana-denominated claim (base58 `channelAccount`) was rejected with
> `F06 — Invalid channelId format (expected 0x-prefixed 64-char hex)`, blocking
> the Solana publish→settle loop at the apex. `validateSolanaClaim` accepts
> `{ blockchain:'solana', programId, channelAccount (base58), nonce,
> transferredAmount, signature, signerPublicKey (base58), cluster? }`. The EVM
> claim shape and the consumed SDK/admin surface are unchanged.
>
> **`3.9.0` — Solana + Mina settlement wired end-to-end (toon-protocol/connector#86),
> purely additive:** non-EVM key resolution (`chainProviders[].keyId` as a raw
> base58 private key, or `SOLANA_PRIVATE_KEY`/`MINA_PRIVATE_KEY` env), bootstrap
> registration of Solana/Mina payment-channel providers, and a non-EVM branch in
> the settlement executor. The consumed SDK/admin surface is unchanged; EVM
> settlement is unaffected.
> Connector `3.7.0+` additionally exposes `packetsLocallyDelivered` in
> `getMetrics().peers[]` (toon-protocol/connector#73), consumed additively by
> Townhouse's earnings aggregator (`eventsRelayed`); this is purely additive and
> does not change the documented shapes below.
>
> **`3.8.0` (Story 50.4 bump) — two runtime fixes, no consumed-surface change:**
> (1) local SQLite migrated from `better-sqlite3` to `libsql`
> (toon-protocol/connector#79), removing the Node-24 native-build failure that
> silently left the settlement/claim subsystem un-wired (value-bearing packets
> auto-fulfilled instead of claim-gated); (2) inbound per-packet claim validation
> is now relation-aware (toon-protocol/connector#78) — a child node skips the
> inline-claim requirement for PREPAREs forwarded by its parent, mirroring the
> existing outbound `requiresSettlementClaim` skip and unblocking Story 50.3's
> AC#1 kind:1 `F06 "No payment channel claim attached"` on the apex→child hop.
> Both are internal to the connector image/runtime; the `sendPacket` / admin /
> earnings shapes documented below are unchanged.
>
> **`3.8.1` (Mina settlement fix) — one runtime fix, no consumed-surface
> change:** the on-chain Mina payment-channel claim path now passes the real
> counterparty balance, salt, and both party signatures to `claimFromChannel`
> instead of the single-sig/zeroed placeholders that left Mina settlement
> un-claimable (toon-protocol/connector#84). EVM and Solana settlement are
> unchanged. Patch over `3.8.0`; internal to the connector's settlement
> executor — the `sendPacket` / admin / earnings shapes documented below are
> unchanged, so the contract canary passes unmodified at the new digest.

### `sendPacket(params: SendPacketParams): Promise<ILPFulfillPacket | ILPRejectPacket>`

```ts
interface SendPacketParams {
  destination: string; // ILP address
  amount: bigint; // amount in token base units
  expiresAt: Date; // MANDATORY — no default
  data?: Buffer;
}
```

- Return type is the discriminated union from `@toon-protocol/shared`:
  - `{ type: PacketType.FULFILL = 13, fulfillment: Buffer, data: Buffer }`
  - `{ type: PacketType.REJECT = 14, code: ILPErrorCode, triggeredBy, message, data }`

### `buildSwarmSelectionEvent(params, secretKey): NostrEvent`

Lives in `@toon-protocol/core`, but is consumed by SDK code that interacts
with the connector's payment paths.

```ts
interface SwarmSelectionParams {
  swarmRequestEventId: string; // 64-char lowercase hex
  winnerResultEventId: string; // 64-char lowercase hex
  customerPubkey: string; // 64-char lowercase hex
}
```

- Returns Kind 7000 (job feedback) Nostr event.
- All three fields are mandatory; the function throws on malformed hex.

### `registerPeer(config: PeerRegistrationRequest): Promise<PeerInfo>`

```ts
interface PeerRegistrationRequest {
  id: string; // mandatory
  url: string; // mandatory (e.g., 'btp+wss://peer.example.com')
  authToken: string; // mandatory
  routes?: Array<{ prefix: string; priority?: number }>;
  settlement?: AdminSettlementConfig;
}
```

### `openChannel(params): Promise<{ channelId: string; status: string }>`

```ts
{
  peerId: string;
  chain: string;          // e.g., 'evm:base:31337'
  token?: string;
  tokenNetwork?: string;
  peerAddress: string;    // e.g., '0x...'
  initialDeposit?: string;
  settlementTimeout?: number;
}
```

### `ConnectorConfig` (top-level config object)

- **Has** `chainProviders?: ChainProviderConfigEntry[]`.
- **Does not have** `settlementInfra` (removed in v3.x).

---

## Breaking Changes — v2.3.0 → v3.3.2

| API                               | v2.3.0 Behavior                    | v3.3.2 Behavior                                                                       | Migration                                                                    |
| --------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `sendPacket().expiresAt`          | Optional; defaulted to `now + 30s` | **Mandatory `Date`**; `params.expiresAt.toISOString()` is called without a null check | Always pass an explicit `Date`                                               |
| `ConnectorConfig.settlementInfra` | Top-level config block             | **Removed**                                                                           | Replace with `chainProviders[]` array                                        |
| `ctx.accept()` return shape       | `{ fulfillment: ... }`             | `fulfillment` field removed from application API (changed in v2.2.0)                  | Drop `fulfillment` from accept-response handling; use `ctx.accept({ data })` |

> **Where these bit us.** Story 22.1 cleaned up trivial config-API drift across
> `dvm`, `mill`, `town`, and `townhouse` packages. Stories 22.2–22.4 unblocked
> downstream E2E flows that depended on the new shape. This canary keeps that
> regression from recurring on the next connector bump.

---

## Townhouse-Side Contract

Townhouse does **not** import `@toon-protocol/connector` at runtime — it pulls the
connector **Docker image** (`ghcr.io/toon-protocol/connector:X.Y.Z`) and communicates
across two seams the SDK canary cannot reach: the admin HTTP API and the
container's config-file contract.

### Seam 1 — Admin HTTP API (`ConnectorAdminClient`)

`packages/townhouse/src/connector/admin-client.ts` mirrors the connector's
served shapes verbatim — see `@toon-protocol/connector`
`packages/connector/src/http/{types,admin-api}.ts` for the source of truth.

The connector image runs **two distinct HTTP servers**:

- **healthCheckPort** — serves `/health`, `/health/live`, `/health/ready`,
  and Prometheus `/metrics` (text format).
- **adminApi.port** — serves `/admin/*` (peers, metrics.json, routes,
  channels, settlement, …).

Pass the appropriate base URL to `ConnectorAdminClient` for each call.

| Method              | Path                                     | Shape                                                                                                                                                                                                                |
| ------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getEarnings()`     | `GET {adminApi.port}/admin/earnings.json` | `EarningsResponse` — `{ uptimeSeconds: number, peers: [{ peerId, byAsset: [{ assetCode, assetScale, claimsReceivedTotal, claimsSentTotal, netBalance, lastClaimAt }] }], connectorFees: [{ assetCode, assetScale, total }], recentClaims: [{ peerId, assetCode, assetScale, amount, direction: 'inbound'\|'outbound', at }], timestamp: { iso } }`. Throws on shape drift. Connector source-of-truth: `@toon-protocol/connector packages/connector/src/http/admin-api.ts:261-304`. Added connector v3.2.0. |
| `getHealth()`       | `GET {healthCheckPort}/health`           | `HealthStatus` — `{ status: 'healthy'\|'unhealthy'\|'starting'\|'degraded', uptime, peersConnected, totalPeers, timestamp, nodeId?, version? }`                                                                      |
| `getPeers()`        | `GET {adminApi.port}/admin/peers`        | Wrapped envelope `{ nodeId, peerCount, connectedCount, peers: [{ id, connected, ilpAddresses, routeCount, settlement? }] }` — client returns the unwrapped `peers` array.                                            |
| `getMetrics()`      | `GET {adminApi.port}/admin/metrics.json` | `AdminMetricsJsonResponse` — `{ uptimeSeconds, aggregate: { packetsForwarded, packetsRejected, bytesSent }, peers: [{ peerId, connected, packetsForwarded, packetsRejected, bytesSent, lastPacketAt }], timestamp }` |
| `getPacketLog(filter)` | `GET {adminApi.port}/packets?ilpAddress=<>&since=<>&limit=<>` | `PacketLogEntry[]` — `[{ ts: number, ilpAddressFrom: string, ilpAddressTo: string, amount: string, result: 'fulfill'\|'reject'\|'timeout' }]`. Throws with `code='ConnectorEndpointNotFound'` on 404. **Note:** `PacketLogEntry` does not carry an event `kind` field. Townhouse's `GET /api/nodes/:nodeId/jobs/recent` feature-detects `entry.kind`; if absent, packets are grouped under bucket `kind: 0` ("unattributed") and the canonical `byKind` is sourced from the DVM container's in-memory health counter instead. To enable per-kind attribution from the connector side, add `kind?: number` to `PacketLogEntry` (populated from the ILP packet's TOON-decoded event kind). |

> **`getEarnings()` (added story 47.1):** When the connector is started without `accountManager` / `claimReceiver` (i.e., without full EVM settlement config), this endpoint returns 503 with `{ error: 'Service Unavailable', message: 'Earnings subsystem not enabled (accountManager or claimReceiver missing)' }` — see connector source `admin-api.ts:1888-1896`. Townhouse's apex always wires both subsystems; 503 in production indicates connector misconfiguration. The wire-level `timestamp: string` is wrapped on the Townhouse side into `EarningsTimestamp { iso: string }` — the adapter lives in `ConnectorAdminClient.getEarnings()`.

> **Status of `getPacketLog` (added story 21.10):** The connector image at `DEFAULT_CONNECTOR_IMAGE` (ghcr.io/toon-protocol/connector:3.3.3) does **not** yet expose `GET /packets`. Until the connector exposes this endpoint, `GET /api/nodes/:type/packets/timeseries` returns 503 with `error: 'connector_endpoint_not_found'`. The contract canary asserts the path and shape so any future connector bump that adds it will also be validated. To unblock: add `GET /packets` to the connector's admin HTTP server and update this table.

### Seam 2 — Container config contract

The connector image reads a `config.yaml` mounted at `/app/config.yaml` to
configure ports, peers, transport mode, and admin API. The standalone
entrypoint does **not** consume runtime env vars for these values. Townhouse
ships its config via the docker-compose mount (`docker-compose-townhouse.yml`)
and the orchestrator's config writer.

`ConnectorConfigGenerator.toEnvVars()` exists for environments that
embed the connector as a library (where env-var-driven config is honored).
The fields it emits map 1:1 to YAML keys in `config.yaml` and are not the
contract Townhouse-via-image relies on.

| Field                                  | Description                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------- |
| `adminPort` / `CONNECTOR_ADMIN_PORT`   | admin API listen port                                                           |
| `ilpAddress` / `CONNECTOR_ILP_ADDRESS` | base ILP address                                                                |
| `peers` / `CONNECTOR_PEERS`            | JSON `PeerEntry[]` — `{ id, relation: 'child', btpUrl, assetCode, assetScale }` |
| `transport.mode` / `TRANSPORT_MODE`    | `'direct'` or `'ator'`                                                          |
| `transport.socksProxy` / `SOCKS_PROXY` | SOCKS proxy URL (when ator mode is active)                                      |

### Canary test files

| File                                                                      | Tier                                                                                    | Runtime                |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------- |
| `packages/townhouse/src/connector/contract-canary.test.ts`                | Stub (no Docker), URL-bound `fetch` mocks — fails on path drift as well as shape drift. | <500 ms                |
| `packages/townhouse/src/__integration__/connector-image-contract.test.ts` | Real container, all assertions routed through `ConnectorAdminClient`.                   | ~5 s after image cache |

---

## Townhouse Migration Steps

When bumping the connector image tag:

1. Compare versions side by side:
   `pnpm view @toon-protocol/connector dist-tags.latest` should match
   `DEFAULT_CONNECTOR_IMAGE` in `packages/townhouse/src/constants.ts`.
2. Update `DEFAULT_CONNECTOR_IMAGE`. The structural test
   (`packages/townhouse/src/package-structure.test.ts`) fails if
   `docker-compose-townhouse.yml` drifts out of sync — fix the literal there
   too if the test flags it.
3. Run the stub canary:
   `pnpm --filter @toon-protocol/townhouse test contract-canary`
4. Run the real-image canary:
   `pnpm --filter @toon-protocol/townhouse test:canary`
5. On failure, the connector source-of-truth has likely changed. Read
   `@toon-protocol/connector` `packages/connector/src/http/{types,admin-api}.ts`
   for the new shapes, update `packages/townhouse/src/connector/types.ts` and
   `admin-client.ts` to match, and back-fill a row in the "Breaking Changes"
   table above.

### Townhouse client (story 47.1) — `getEarnings()` wraps `/admin/earnings.json`

The `/admin/earnings.json` endpoint was added in **connector v3.2.0**; story 47.1 adds the
Townhouse-side wrap (`ConnectorAdminClient.getEarnings(): Promise<EarningsResponse>`) targeting
the **v3.3.3+** floor in `DEFAULT_CONNECTOR_IMAGE`. If you are bumping to a connector version
older than v3.2.0, the canary will fail on this endpoint.
Verify:
- `packages/townhouse/src/connector/types.ts` — 6 earnings interfaces (`AssetEarnings`,
  `PeerEarnings`, `ConnectorFeeEntry`, `RecentClaim`, `EarningsTimestamp`, `EarningsResponse`)
- `packages/townhouse/src/connector/admin-client.ts` — `getEarnings()` method
- `packages/townhouse/src/connector/index.ts` — all 6 types re-exported
- `packages/townhouse/src/connector/contract-canary.test.ts` — `getEarnings()` shape contract block
- `packages/townhouse/src/__integration__/connector-image-contract.test.ts` — image canary assertion

---

## When to Update This Document

Update **this file** and the contract canaries together when:

1. Bumping `@toon-protocol/connector` to a new minor or major version.
2. Adding a new connector method to the SDK's public surface.
3. Adding a new admin endpoint consumed by `ConnectorAdminClient`.
4. Discovering a new breaking change after a connector upgrade — back-fill the
   row, then add a guard in the relevant canary file so the next regression
   fails fast.

The SDK canary command:

```bash
pnpm --filter @toon-protocol/sdk test:integration -- tests/integration/connector-contract.test.ts
```

Expected runtime: <2 seconds. Hard ceiling: 60 seconds (per-test timeout).

The Townhouse canary commands:

```bash
pnpm --filter @toon-protocol/townhouse test contract-canary       # stub, <500ms
pnpm --filter @toon-protocol/townhouse test:canary                # real image, ~5s
```

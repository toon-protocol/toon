# `@toon-protocol/connector` Migration Guide

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

## Current Contract — `@toon-protocol/connector` >=3.3.2

The SDK consumes these connector APIs. Each entry below is asserted by the
contract canary.

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
| `getHealth()`       | `GET {healthCheckPort}/health`           | `HealthStatus` — `{ status: 'healthy'\|'unhealthy'\|'starting'\|'degraded', uptime, peersConnected, totalPeers, timestamp, nodeId?, version? }`                                                                      |
| `getPeers()`        | `GET {adminApi.port}/admin/peers`        | Wrapped envelope `{ nodeId, peerCount, connectedCount, peers: [{ id, connected, ilpAddresses, routeCount, settlement? }] }` — client returns the unwrapped `peers` array.                                            |
| `getMetrics()`      | `GET {adminApi.port}/admin/metrics.json` | `AdminMetricsJsonResponse` — `{ uptimeSeconds, aggregate: { packetsForwarded, packetsRejected, bytesSent }, peers: [{ peerId, connected, packetsForwarded, packetsRejected, bytesSent, lastPacketAt }], timestamp }` |
| `getPacketLog(filter)` | `GET {adminApi.port}/packets?ilpAddress=<>&since=<>&limit=<>` | `PacketLogEntry[]` — `[{ ts: number, ilpAddressFrom: string, ilpAddressTo: string, amount: string, result: 'fulfill'\|'reject'\|'timeout' }]`. Throws with `code='ConnectorEndpointNotFound'` on 404. **Note:** `PacketLogEntry` does not carry an event `kind` field. Townhouse's `GET /api/nodes/:nodeId/jobs/recent` feature-detects `entry.kind`; if absent, packets are grouped under bucket `kind: 0` ("unattributed") and the canonical `byKind` is sourced from the DVM container's in-memory health counter instead. To enable per-kind attribution from the connector side, add `kind?: number` to `PacketLogEntry` (populated from the ILP packet's TOON-decoded event kind). |

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

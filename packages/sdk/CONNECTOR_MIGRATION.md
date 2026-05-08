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

## Current Contract — `@toon-protocol/connector` >=3.3.2

The SDK consumes these connector APIs. Each entry below is asserted by the
contract canary.

### `sendPacket(params: SendPacketParams): Promise<ILPFulfillPacket | ILPRejectPacket>`

```ts
interface SendPacketParams {
  destination: string;   // ILP address
  amount: bigint;        // amount in token base units
  expiresAt: Date;       // MANDATORY — no default
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
  swarmRequestEventId: string;   // 64-char lowercase hex
  winnerResultEventId: string;   // 64-char lowercase hex
  customerPubkey: string;        // 64-char lowercase hex
}
```

- Returns Kind 7000 (job feedback) Nostr event.
- All three fields are mandatory; the function throws on malformed hex.

### `registerPeer(config: PeerRegistrationRequest): Promise<PeerInfo>`

```ts
interface PeerRegistrationRequest {
  id: string;            // mandatory
  url: string;           // mandatory (e.g., 'btp+wss://peer.example.com')
  authToken: string;     // mandatory
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

| API | v2.3.0 Behavior | v3.3.2 Behavior | Migration |
| --- | --- | --- | --- |
| `sendPacket().expiresAt` | Optional; defaulted to `now + 30s` | **Mandatory `Date`**; `params.expiresAt.toISOString()` is called without a null check | Always pass an explicit `Date` |
| `ConnectorConfig.settlementInfra` | Top-level config block | **Removed** | Replace with `chainProviders[]` array |
| `ctx.accept()` return shape | `{ fulfillment: ... }` | `fulfillment` field removed from application API (changed in v2.2.0) | Drop `fulfillment` from accept-response handling; use `ctx.accept({ data })` |

> **Where these bit us.** Story 22.1 cleaned up trivial config-API drift across
> `dvm`, `mill`, `town`, and `townhouse` packages. Stories 22.2–22.4 unblocked
> downstream E2E flows that depended on the new shape. This canary keeps that
> regression from recurring on the next connector bump.

---

## When to Update This Document

Update **this file** and the contract canary together when:

1. Bumping `@toon-protocol/connector` to a new minor or major version.
2. Adding a new connector method to the SDK's public surface.
3. Discovering a new breaking change after a connector upgrade — back-fill the
   row, then add a guard in `connector-contract.test.ts` so the next
   regression fails fast.

The canary command:

```bash
pnpm --filter @toon-protocol/sdk test:integration -- tests/integration/connector-contract.test.ts
```

Expected runtime: <2 seconds. Hard ceiling: 60 seconds (per-test timeout).

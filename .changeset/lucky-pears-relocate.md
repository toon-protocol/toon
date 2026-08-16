---
'@toon-protocol/sdk': minor
---

Relocate the swap symbols the **rolling** path shares out of the **legacy** swap
files (toon#210, ADR 0003 stage 3).

**Nothing is withdrawn, added, renamed or re-typed.** This is a source-only move
so that ADR 0003's stage 7 — deleting `swap-handler.ts` and `stream-swap.ts`
with `createSwapHandler` — is a mechanical deletion instead of one that silently
breaks the rolling engine.

Moved (same exported names, same barrels, same types):

- `applyRate` / `ApplyRateParams` → `apply-rate.ts` (was `swap-handler.ts`).
  Rolling importers: the SDK's own `adaptive-controller.ts` and
  `@toon-protocol/swap`'s `rolling-engine.ts`.
- `IssueClaimParams` / `IssueClaimResult` → `claim-issuance.ts` (was
  `swap-handler.ts`). `@toon-protocol/swap`'s rolling `IssueRollingClaimParams`
  / `RollingIssueClaimResult` extend them.
- `AccumulatedClaim` → `settlement/accumulated-claim.ts` (was `stream-swap.ts`).
  It is a settlement type — `buildSettlementTx` / `verifyAccumulatedClaim` and
  `@toon-protocol/client`'s rolling reveal/settle paths all consume it.

The published surface is unchanged: the runtime export sets of both
`@toon-protocol/sdk` and `@toon-protocol/sdk/swap` are byte-identical to the
previous release (79 and 14 names), the emitted `.d.ts` declarations are
structurally identical, and the frozen public-API guard at
`packages/sdk/src/index.test.ts` is untouched. `@toon-protocol/swap` and
`@toon-protocol/client` build, typecheck and pass their suites against this
version with zero source changes.

Shipped as a **minor** rather than a patch because it is the versioned,
revertible checkpoint stage 7's major depends on — not because any consumer can
observe a difference.

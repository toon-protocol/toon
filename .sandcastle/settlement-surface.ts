// Which changed files make the Solana settlement redemption proof relevant.
//
// toon#215 added `packages/sdk/tests/integration/solana-claim-redeem.integration.test.ts`:
// a real `solana-test-validator` running the real payment-channel program,
// executing a real claim and asserting on-chain state moved. It shipped in its
// own workflow, deliberately NOT part of the `CI OK` aggregate, because a
// ~90s job folded into ci.yml blows the frozen
// `.sandcastle/gate-baseline.json` summed-runner-second ceiling. That left the
// only executable evidence that Solana settlement works as a non-required
// check on a repo whose single required context is `CI OK`: it could go red,
// or stop running, and nothing would block.
//
// The proof is now a job in ci.yml, gated by the aggregate, and CONDITIONAL on
// the change set touching one of the paths below -- so it costs nothing on the
// PRs it cannot say anything about, and blocks the ones it can.
//
// The decision lives here, in a tested module, rather than in a workflow
// `paths:` filter, for three reasons:
//
//  1. A workflow-level `paths:` filter cannot gate a JOB, and a required
//     check that is skipped by its own filter may never report at all.
//  2. `decideSettlementSurface` FAILS SAFE: an unenumerable or empty change
//     set runs the proof rather than skipping it. A filter cannot express that.
//  3. `settlement-surface.test.ts` asserts every path below still exists in
//     the repo, so a rename that orphans an entry -- silently making the
//     filter match nothing forever -- is a red gate rather than a quiet
//     downgrade.

/**
 * Sentinel line ci.yml writes into the change-set file when it cannot
 * enumerate the change (an event with no diff to read). Any unknown means
 * "run the proof".
 */
export const UNKNOWN_CHANGE_SET = '__UNKNOWN__';

export interface SettlementSurfaceEntry {
  /**
   * Repo-relative path. A trailing `/` means "this directory and everything
   * under it"; anything else is an exact file match.
   */
  path: string;
  /** Why a change here invalidates the proof's last green run. */
  why: string;
}

/**
 * The Solana settlement surface.
 *
 * Deliberately NOT included, so the omission is a recorded decision rather
 * than an oversight:
 *  - `pnpm-lock.yaml` / `package.json`: a dependency bump can in principle
 *    move the Ed25519 signing path, but lockfile churn is frequent (every
 *    Version Packages PR) and the proof re-runs on every push to `main`
 *    that touches the code surface. Add it here if a dep bump ever breaks
 *    redemption.
 *  - each package's top-level `src/index.ts` barrel: they only re-export the
 *    settlement modules already covered below.
 */
export const SETTLEMENT_SURFACE: readonly SettlementSurfaceEntry[] = [
  {
    path: 'packages/sdk/src/settlement/',
    why: 'builds the settlement bundle and signs the claim digest the chain verifies',
  },
  {
    path: 'packages/settlement-digest/src/',
    why: 'defines the canonical digest the on-chain program checks the signature against',
  },
  {
    path: 'packages/core/src/settlement/',
    why: 'core re-exports/owns settlement hashing shared with the connector',
  },
  {
    path: 'packages/sdk/tests/integration/solana-claim-redeem.integration.test.ts',
    why: 'the proof itself',
  },
  {
    path: 'packages/sdk/tests/integration/fixtures/solana/',
    why: 'the vendored program binary and genesis channel account the proof loads',
  },
  {
    path: 'packages/sdk/vitest.integration.config.ts',
    why: 'the config the proof runs under (env, timeouts, include globs)',
  },
  {
    path: '.github/workflows/ci.yml',
    why: 'the workflow that runs the proof and computes the CI OK aggregate',
  },
  {
    path: '.sandcastle/settlement-surface.ts',
    why: 'this list -- editing what counts as the surface must re-run the proof',
  },
];

export interface SurfaceDecision {
  /** True = the Solana settlement proof must run and must pass. */
  touched: boolean;
  /** Human-readable justification, printed into the CI log. */
  reason: string;
  /** The changed files that matched, for the log. */
  matches: readonly string[];
}

export function matchSettlementSurface(changedPath: string): SettlementSurfaceEntry | undefined {
  const normalized = changedPath.trim().replace(/^\.\//, '');
  if (normalized === '') return undefined;

  return SETTLEMENT_SURFACE.find((entry) =>
    entry.path.endsWith('/')
      ? normalized.startsWith(entry.path)
      : normalized === entry.path,
  );
}

/**
 * Decide whether the proof must run for a change set.
 *
 * Fails safe in both unknown directions: an unenumerable change set (the
 * sentinel) and an empty one both run the proof. "We could not tell" must
 * never be spelled "skip the only executable evidence that settlement works".
 */
export function decideSettlementSurface(changedFiles: readonly string[]): SurfaceDecision {
  const files = changedFiles.map((line) => line.trim()).filter((line) => line !== '');

  if (files.includes(UNKNOWN_CHANGE_SET)) {
    return {
      touched: true,
      reason: `change set could not be enumerated (${UNKNOWN_CHANGE_SET}) — running the proof rather than assuming it is irrelevant`,
      matches: [],
    };
  }

  if (files.length === 0) {
    return {
      touched: true,
      reason:
        'the change set came back empty, which no real commit produces — running the proof rather than trusting a filter that matched nothing',
      matches: [],
    };
  }

  const matches = files.filter((file) => matchSettlementSurface(file) !== undefined);

  if (matches.length === 0) {
    return {
      touched: false,
      reason: `none of the ${files.length} changed file(s) touch the Solana settlement surface`,
      matches: [],
    };
  }

  return {
    touched: true,
    reason: `${matches.length} of ${files.length} changed file(s) touch the Solana settlement surface`,
    matches,
  };
}

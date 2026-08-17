import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  decideSettlementSurface,
  matchSettlementSurface,
  SETTLEMENT_SURFACE,
  UNKNOWN_CHANGE_SET,
} from './settlement-surface.ts';

const SANDCASTLE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SANDCASTLE_DIR, '..');

const CI_YML = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

const BASELINE = JSON.parse(readFileSync(join(SANDCASTLE_DIR, 'gate-baseline.json'), 'utf8')) as {
  gateSpeed: {
    excludedJobNames?: string[];
    requiredMeasuredJobNames?: string[];
  };
};

/** The display name of the proof job, as ci.yml declares it. */
const PROOF_JOB_NAME = 'Solana settlement redemption proof';
const PROOF_JOB_ID = 'solana-settlement-proof';

describe('matchSettlementSurface', () => {
  it('matches an exact-file entry', () => {
    expect(
      matchSettlementSurface(
        'packages/sdk/tests/integration/solana-claim-redeem.integration.test.ts',
      ),
    ).toBeDefined();
  });

  it('matches anything under a directory entry', () => {
    expect(matchSettlementSurface('packages/sdk/src/settlement/build-settlement-tx.ts')).toBeDefined();
    expect(matchSettlementSurface('packages/sdk/src/settlement/nested/deep/file.ts')).toBeDefined();
  });

  it('does not match a sibling directory that merely shares a prefix', () => {
    // Without the trailing slash on the surface entry, this would match and the
    // proof would run on changes it says nothing about.
    expect(matchSettlementSurface('packages/sdk/src/settlement-legacy/thing.ts')).toBeUndefined();
  });

  it('does not match unrelated code', () => {
    expect(matchSettlementSurface('packages/core/src/events/kinds.ts')).toBeUndefined();
    expect(matchSettlementSurface('README.md')).toBeUndefined();
  });

  it('tolerates ./-prefixed and whitespace-padded paths', () => {
    expect(matchSettlementSurface('./packages/settlement-digest/src/hashes.ts')).toBeDefined();
    expect(matchSettlementSurface('  packages/settlement-digest/src/hashes.ts  ')).toBeDefined();
  });
});

describe('decideSettlementSurface', () => {
  it('runs the proof when a settlement file changed', () => {
    const decision = decideSettlementSurface([
      'README.md',
      'packages/sdk/src/settlement/hashes.ts',
    ]);
    expect(decision.touched).toBe(true);
    expect(decision.matches).toEqual(['packages/sdk/src/settlement/hashes.ts']);
  });

  it('skips the proof when nothing on the surface changed', () => {
    const decision = decideSettlementSurface(['README.md', 'packages/core/src/logger.ts']);
    expect(decision.touched).toBe(false);
    expect(decision.matches).toEqual([]);
  });

  // The two fail-safe directions. A skipped proof is only ever acceptable
  // because a decision that RAN said the surface was untouched; "we could not
  // tell" must not be spelled the same way.
  it('fails safe when the change set could not be enumerated', () => {
    const decision = decideSettlementSurface([UNKNOWN_CHANGE_SET]);
    expect(decision.touched).toBe(true);
    expect(decision.reason).toContain('could not be enumerated');
  });

  it('fails safe on an empty change set rather than reading it as irrelevant', () => {
    expect(decideSettlementSurface([]).touched).toBe(true);
    expect(decideSettlementSurface(['', '   ', '\n']).touched).toBe(true);
  });

  // The change set of toon#215, the commit that added the proof. If the
  // surface list ever stops recognising the very change it was written for,
  // that is a broken filter.
  it('recognises the change set of the commit that added the proof (toon#215)', () => {
    const decision = decideSettlementSurface([
      '.changeset/loud-pandas-redeem.md',
      'packages/core/src/index.ts',
      'packages/core/src/settlement/hashes.ts',
      'packages/sdk/src/index.ts',
      'packages/sdk/src/settlement/solana.ts',
      'packages/sdk/tests/integration/fixtures/solana/payment_channel.so',
      'packages/sdk/tests/integration/solana-claim-redeem.integration.test.ts',
      'packages/settlement-digest/src/hashes.ts',
    ]);
    expect(decision.touched).toBe(true);
  });
});

describe('the committed settlement surface', () => {
  // A rename that orphans an entry would leave the filter matching nothing
  // forever -- the proof would silently never run again, which is the exact
  // failure mode this gate exists to prevent.
  it('names only paths that still exist in the repo', () => {
    const missing = SETTLEMENT_SURFACE.filter((entry) => !existsSync(join(REPO_ROOT, entry.path)));
    expect(missing.map((entry) => entry.path)).toEqual([]);
  });

  it('records why each path is on the surface', () => {
    for (const entry of SETTLEMENT_SURFACE) {
      expect(entry.why.length).toBeGreaterThan(10);
    }
  });

  it('covers the workflow and the decision module themselves', () => {
    const paths = SETTLEMENT_SURFACE.map((entry) => entry.path);
    expect(paths).toContain('.github/workflows/ci.yml');
    expect(paths).toContain('.sandcastle/settlement-surface.ts');
  });
});

// These read ci.yml as text rather than parsing YAML: the point is only that
// the proof cannot be quietly unwired from the aggregate without a red test.
describe('ci.yml wires the proof into the CI OK aggregate', () => {
  it('declares the proof job', () => {
    expect(CI_YML).toContain(`${PROOF_JOB_ID}:`);
    expect(CI_YML).toContain(`name: ${PROOF_JOB_NAME}`);
  });

  it('runs the proof only when the surface decision says so', () => {
    expect(CI_YML).toContain("needs.build.outputs.settlement_surface_touched == 'true'");
  });

  it('caps the proof job with a wall-clock timeout', () => {
    const proofBlock = CI_YML.slice(CI_YML.indexOf(`${PROOF_JOB_ID}:`));
    expect(/timeout-minutes: \d+/.test(proofBlock.slice(0, 2000))).toBe(true);
  });

  it('makes the proof a dependency of the aggregate', () => {
    const aggregate = CI_YML.slice(CI_YML.indexOf('  ci-ok:'));
    const needs = /needs: \[([^\]]+)\]/.exec(aggregate);
    expect(needs?.[1]).toContain(PROOF_JOB_ID);
  });

  // A bare `needs:` blocks nothing: a job skipped by its own `if:` reports
  // `skipped`, and branch protection reads a skipped required check as a pass
  // (toon#209 hit exactly this). The aggregate must therefore assert on the
  // proof's RESULT, paired with the decision that justified it.
  it('asserts on the proof result, paired with the surface decision', () => {
    const aggregate = CI_YML.slice(CI_YML.indexOf('  ci-ok:'));
    expect(aggregate).toContain('needs.solana-settlement-proof.result');
    expect(aggregate).toContain('needs.build.outputs.settlement_surface_touched');
  });

  it('has no separate solana-settlement-proof workflow that would double-run it', () => {
    expect(
      existsSync(join(REPO_ROOT, '.github', 'workflows', 'solana-settlement-proof.yml')),
    ).toBe(false);
  });
});

describe("the proof's exclusion from the frozen speed/performance baseline", () => {
  // The proof is excluded from the baselined figures by NAME. A rename in
  // ci.yml would leave a dangling exclusion and a ~90s job silently inside a
  // 163.2s summed-runner-second ceiling -- a false FAIL on exactly the PRs
  // that touch settlement. Pin the two spellings together.
  it('names the job ci.yml actually declares', () => {
    expect(BASELINE.gateSpeed.excludedJobNames).toContain(PROOF_JOB_NAME);
  });

  it('never excludes a job the baseline requires to be measured', () => {
    const excluded = BASELINE.gateSpeed.excludedJobNames ?? [];
    const required = BASELINE.gateSpeed.requiredMeasuredJobNames ?? [];
    expect(required.length).toBeGreaterThan(0);
    expect(required.filter((name) => excluded.includes(name))).toEqual([]);
  });
});

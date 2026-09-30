// The sandbox gate must be CI's `build` job, not something similar to it. These pin
// that from the seam that matters: the step list the runner executes, read against the
// workflow it claims to mirror.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BUILD_STEPS, SOLANA_PROOF_STEP, gateSteps } from './run-gate.ts';
import { UNKNOWN_CHANGE_SET } from './settlement-surface.ts';

const ciYml = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../.github/workflows/ci.yml'),
  'utf8'
);

/** Commands of ci.yml's `build` job (everything before the next job), whitespace-collapsed. */
const buildJob = ciYml
  .slice(ciYml.indexOf('\n  build:'), ciYml.indexOf('\n  devbox-validate:'))
  .replace(/\s+/g, ' ');

describe('gate steps', () => {
  it('run only commands that ci.yml`s build job runs, in its order', () => {
    let from = 0;
    for (const step of BUILD_STEPS) {
      for (const part of step.command.split(' && ')) {
        const at = buildJob.indexOf(part, from);
        expect(at, `${step.name}: "${part}" is not in ci.yml's build job after "${from}"`).toBeGreaterThan(-1);
        from = at;
      }
    }
  });

  it('runs the Solana proof through the same test file and assertions as ci.yml', () => {
    const proofJob = ciYml.slice(ciYml.indexOf('\n  solana-settlement-proof:')).replace(/\s+/g, ' ');
    expect(proofJob).toContain('tests/integration/solana-claim-redeem.integration.test.ts');
    expect(proofJob).toContain('SDK_REQUIRE_SOLANA: \'1\'');
    expect(SOLANA_PROOF_STEP.command).toContain('SDK_REQUIRE_SOLANA=1');
    expect(proofJob).toContain("Tests +5 passed \\(5\\)");
    expect(SOLANA_PROOF_STEP.command).toContain("Tests +5 passed \\(5\\)");
    expect(proofJob).toContain('[solana-redeem\\] tx ');
    expect(SOLANA_PROOF_STEP.command).toContain('[solana-redeem\\] tx ');
  });
});

describe('gateSteps', () => {
  it('skips the Solana proof when the change set cannot touch the settlement surface', () => {
    expect(gateSteps(['README.md', 'packages/core/src/wire/giftwrap.ts'])).toEqual(BUILD_STEPS);
  });

  it('adds the Solana proof when the change set touches the settlement surface', () => {
    const steps = gateSteps(['packages/sdk/src/settlement/bundle.ts']);
    expect(steps).toEqual([...BUILD_STEPS, SOLANA_PROOF_STEP]);
  });

  it('fails safe: an unreadable or empty change set runs the proof', () => {
    expect(gateSteps(null).at(-1)).toBe(SOLANA_PROOF_STEP);
    expect(gateSteps([]).at(-1)).toBe(SOLANA_PROOF_STEP);
    expect(gateSteps([UNKNOWN_CHANGE_SET]).at(-1)).toBe(SOLANA_PROOF_STEP);
  });
});

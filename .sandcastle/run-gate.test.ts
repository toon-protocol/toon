// The sandbox gate must be CI's `build` job, not something similar to it. This pins
// that from the seam that matters: the step list the runner executes, read against the
// workflow it claims to mirror.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BUILD_STEPS } from './run-gate.ts';

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
});

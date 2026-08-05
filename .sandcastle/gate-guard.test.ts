import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkImageSizeRegression,
  checkLintCeiling,
  checkMeasurementCoverage,
  checkPerformanceRegression,
  checkSpeedRegression,
  computeJobDurationsSeconds,
  PERFORMANCE_REGRESSION_TOLERANCE,
  selectMeasurableJobs,
  SPEED_REGRESSION_TOLERANCE,
  type GateBaseline,
} from './gate-guard.ts';

const baseline: GateBaseline = {
  gateSpeed: {
    averageLongestJobDurationSeconds: 106.6,
    averageTotalRunDurationSeconds: 106.6,
  },
  gatePerformance: {
    runnerMinutes: {
      averagePerRunSeconds: 154.6,
    },
    dockerImageSize: {},
  },
  gateCorrectness: {
    lint: {
      maxWarningsCeiling: 940,
    },
  },
};

describe('checkLintCeiling', () => {
  it('passes when the ceiling matches the frozen baseline', () => {
    const result = checkLintCeiling('eslint . --max-warnings 940', baseline);
    expect(result.pass).toBe(true);
  });

  it('passes when the ceiling is below the frozen baseline', () => {
    const result = checkLintCeiling('eslint . --max-warnings 900', baseline);
    expect(result.pass).toBe(true);
  });

  it('fails when the ceiling is silently raised above the frozen baseline', () => {
    const result = checkLintCeiling('eslint . --max-warnings 950', baseline);
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('exceeds the frozen baseline');
  });

  it('fails when the lint script has no --max-warnings flag at all', () => {
    const result = checkLintCeiling('eslint .', baseline);
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('no --max-warnings ceiling');
  });

  it('handles the --max-warnings=N form', () => {
    const result = checkLintCeiling('eslint . --max-warnings=940', baseline);
    expect(result.pass).toBe(true);
  });
});

describe('computeJobDurationsSeconds', () => {
  it('computes per-job duration, longest job, wall-clock span, and summed runner-seconds for parallel jobs', () => {
    const result = computeJobDurationsSeconds([
      { name: 'build', started_at: '2026-07-22T00:00:00Z', completed_at: '2026-07-22T00:01:40Z' },
      {
        name: 'Devbox Environment Validation',
        started_at: '2026-07-22T00:00:05Z',
        completed_at: '2026-07-22T00:00:50Z',
      },
    ]);

    expect(result.byName.build).toBe(100);
    expect(result.byName['Devbox Environment Validation']).toBe(45);
    expect(result.longestJobSeconds).toBe(100);
    // wall clock = latest completion (00:01:40) - earliest start (00:00:00)
    expect(result.totalWallClockSeconds).toBe(100);
    // runner-seconds = sum of both jobs' durations
    expect(result.sumRunnerSeconds).toBe(145);
  });

  it('returns zero durations for an empty job list', () => {
    const result = computeJobDurationsSeconds([]);
    expect(result.totalWallClockSeconds).toBe(0);
    expect(result.longestJobSeconds).toBe(0);
    expect(result.sumRunnerSeconds).toBe(0);
    expect(result.byName).toEqual({});
  });

  // toon#151, the exact numbers from the toon#150 incident: ten factory PRs
  // saturated the shared runner pool, devbox-validate did not get a runner
  // until after build had finished, and the span ballooned to 402s while the
  // work itself was unchanged. The gated figures must not move with the queue.
  it('reports queue time separately and keeps the gated figures queue-immune', () => {
    const queued = computeJobDurationsSeconds([
      {
        name: 'build',
        created_at: '2026-08-05T20:56:24Z',
        started_at: '2026-08-05T20:57:02Z',
        completed_at: '2026-08-05T20:58:35Z',
      },
      {
        name: 'Devbox Environment Validation',
        created_at: '2026-08-05T20:56:24Z',
        started_at: '2026-08-05T21:02:50Z',
        completed_at: '2026-08-05T21:03:44Z',
      },
    ]);

    expect(queued.totalWallClockSeconds).toBe(402);
    expect(queued.totalQueueSeconds).toBe(38 + 386);
    // ...while the gated figures see only the work.
    expect(queued.longestJobSeconds).toBe(93);
    expect(queued.sumRunnerSeconds).toBe(147);
    expect(checkSpeedRegression(queued.longestJobSeconds, baseline).pass).toBe(true);
    expect(checkPerformanceRegression(queued.sumRunnerSeconds, baseline).pass).toBe(true);
  });

  it('clamps negative queue time from jobs carried over into a later attempt', () => {
    // "Re-run failed jobs" stamps the NEW attempt's created_at onto jobs that
    // kept their original start/finish, which reads as negative queue time.
    const result = computeJobDurationsSeconds([
      {
        name: 'build',
        created_at: '2026-08-05T21:10:00Z',
        started_at: '2026-08-05T20:57:02Z',
        completed_at: '2026-08-05T20:58:35Z',
      },
    ]);
    expect(result.totalQueueSeconds).toBe(0);
    expect(result.longestJobSeconds).toBe(93);
  });
});

describe('selectMeasurableJobs', () => {
  const jobs = [
    {
      name: 'build',
      started_at: '2026-08-05T21:15:06Z',
      completed_at: '2026-08-05T21:16:53Z',
      run_attempt: 2,
    },
    {
      name: 'build',
      started_at: '2026-08-05T20:57:02Z',
      completed_at: '2026-08-05T20:58:35Z',
      run_attempt: 1,
    },
    {
      // The guard's own job, still running while it reads the API.
      name: 'Gate speed/performance no-regression guard',
      started_at: '2026-08-05T21:20:55Z',
      completed_at: null,
      run_attempt: 2,
    },
  ];

  it('drops jobs that have not finished', () => {
    const selected = selectMeasurableJobs(jobs, { attempt: 2 });
    expect(selected.map((job) => job.name)).toEqual(['build']);
  });

  it('measures the current attempt rather than the first attempt of the run', () => {
    expect(selectMeasurableJobs(jobs, { attempt: 1 })).toHaveLength(1);
    expect(selectMeasurableJobs(jobs, { attempt: 1 })[0]?.started_at).toBe('2026-08-05T20:57:02Z');
    expect(selectMeasurableJobs(jobs, { attempt: 2 })[0]?.started_at).toBe('2026-08-05T21:15:06Z');
  });

  it('never measures the guard job itself, even if it shows as completed', () => {
    const withCompletedGuard = [
      ...jobs.slice(0, 1),
      {
        name: 'Gate speed/performance no-regression guard',
        started_at: '2026-08-05T21:20:55Z',
        completed_at: '2026-08-05T21:21:24Z',
        run_attempt: 2,
      },
    ];
    const selected = selectMeasurableJobs(withCompletedGuard, {
      attempt: 2,
      excludeNames: ['Gate speed/performance no-regression guard'],
    });
    expect(selected.map((job) => job.name)).toEqual(['build']);
  });
});

describe('checkMeasurementCoverage', () => {
  it('fails when nothing was measured, instead of passing on all-zero durations', () => {
    const empty = computeJobDurationsSeconds([]);
    // Every threshold is trivially satisfied by zero...
    expect(checkSpeedRegression(empty.longestJobSeconds, baseline).pass).toBe(true);
    expect(checkPerformanceRegression(empty.sumRunnerSeconds, baseline).pass).toBe(true);
    // ...so an empty measurement has to be caught on its own.
    const result = checkMeasurementCoverage(0);
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('no completed jobs to measure');
  });

  it('passes once at least one job was measured', () => {
    expect(checkMeasurementCoverage(2).pass).toBe(true);
  });
});

describe('checkSpeedRegression', () => {
  it('passes when the longest job is within tolerance of the baseline average', () => {
    const result = checkSpeedRegression(120, baseline);
    expect(result.pass).toBe(true);
  });

  it('fails when the longest job exceeds baseline average + tolerance', () => {
    const result = checkSpeedRegression(106.6 * 1.6, baseline);
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('gate speed regressed');
  });

  // toon#153: the tolerance was ratcheted from the span-era 50% down to a
  // figure calibrated against averageLongestJobDurationSeconds's own
  // observed spread (see gate-baseline.json's gateSpeed.regressionTolerance
  // and its rationale). Pin the exact value so a future edit that widens it
  // back toward 50% fails a test instead of silently regressing.
  it('uses a 20% tolerance, not the retired 50% span-era value', () => {
    expect(SPEED_REGRESSION_TOLERANCE).toBe(0.2);
  });

  it('passes at 112s, the highest longestJobSeconds among the baseline sampleRuns (top of observed normal variance)', () => {
    const result = checkSpeedRegression(112, baseline);
    expect(result.pass).toBe(true);
  });

  it('fails a genuine 40% compute regression', () => {
    const result = checkSpeedRegression(106.6 * 1.4, baseline);
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('gate speed regressed');
  });

  it('reads the frozen baseline number, not a live threshold, for the same commit', () => {
    const first = checkSpeedRegression(112, baseline);
    const second = checkSpeedRegression(112, baseline);
    expect(first).toEqual(second);
  });

  it('fails loudly when the baseline has no longest-job figure, rather than silently passing', () => {
    const unthresholded: GateBaseline = {
      ...baseline,
      gateSpeed: { averageTotalRunDurationSeconds: 106.6 },
    };
    const result = checkSpeedRegression(1, unthresholded);
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('averageLongestJobDurationSeconds');
  });
});

describe('the committed gate-baseline.json', () => {
  const committed = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'gate-baseline.json'), 'utf8'),
  ) as GateBaseline;

  it('carries the gating speed figure the guard reads', () => {
    expect(typeof committed.gateSpeed.averageLongestJobDurationSeconds).toBe('number');
  });

  // toon#153: the recorded rationale documents the tolerance the code
  // actually enforces; a hand-edit of one without the other should fail
  // this test rather than silently drift.
  it('records the ratcheted tolerances next to the numbers they were derived from', () => {
    const gateSpeed = committed.gateSpeed as unknown as { regressionTolerance?: number };
    const runnerMinutes = committed.gatePerformance.runnerMinutes as unknown as {
      regressionTolerance?: number;
    };
    expect(gateSpeed.regressionTolerance).toBe(SPEED_REGRESSION_TOLERANCE);
    expect(runnerMinutes.regressionTolerance).toBe(PERFORMANCE_REGRESSION_TOLERANCE);
  });

  // The regression this guard exists to catch: a change that genuinely makes
  // a gate job much slower must still go red against the committed numbers.
  it('still fails a genuine 2x slowdown of the longest job', () => {
    const doubled = (committed.gateSpeed.averageLongestJobDurationSeconds ?? 0) * 2;
    expect(checkSpeedRegression(doubled, committed).pass).toBe(false);
    expect(checkPerformanceRegression(committed.gatePerformance.runnerMinutes.averagePerRunSeconds * 2, committed).pass).toBe(
      false,
    );
  });

  // toon#153: a genuine 40% compute regression must still fail even at the
  // tighter, ratcheted tolerance -- the whole point of tightening it.
  it('fails a 40% slowdown of the longest job or of summed runner-seconds', () => {
    const longestJobSlowdown = (committed.gateSpeed.averageLongestJobDurationSeconds ?? 0) * 1.4;
    const runnerSecondsSlowdown = committed.gatePerformance.runnerMinutes.averagePerRunSeconds * 1.4;
    expect(checkSpeedRegression(longestJobSlowdown, committed).pass).toBe(false);
    expect(checkPerformanceRegression(runnerSecondsSlowdown, committed).pass).toBe(false);
  });

  // toon#153: the highest individual sampleRuns figures (112s longest job,
  // 158s summed runner-seconds) must still pass -- the ratcheted tolerance
  // must never false-FAIL on the normal variance it was calibrated against.
  it('passes at the top of the observed sampleRuns variance', () => {
    const sampleRuns = committed.sampleRuns ?? [];
    expect(sampleRuns.length).toBeGreaterThan(0);
    const topLongestJob = Math.max(...sampleRuns.map((run) => run.longestJobSeconds));
    const topSumRunnerSeconds = Math.max(...sampleRuns.map((run) => run.sumRunnerSeconds));
    expect(checkSpeedRegression(topLongestJob, committed).pass).toBe(true);
    expect(checkPerformanceRegression(topSumRunnerSeconds, committed).pass).toBe(true);
  });

  // toon#150's actual measurements: 93.0s longest job / 147.0s summed.
  it('passes toon#150, whose compute was inside baseline all along', () => {
    expect(checkSpeedRegression(93, committed).pass).toBe(true);
    expect(checkPerformanceRegression(147, committed).pass).toBe(true);
  });
});

describe('checkPerformanceRegression', () => {
  it('passes when runner-seconds are within tolerance of the baseline average', () => {
    const result = checkPerformanceRegression(160, baseline);
    expect(result.pass).toBe(true);
  });

  it('fails when runner-seconds exceed baseline average + tolerance', () => {
    const result = checkPerformanceRegression(154.6 * 1.6, baseline);
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('gate performance regressed');
  });

  // toon#153: runner-seconds' observed spread (~3.6%) is tighter than the
  // longest-job figure's (~6.2%), so it gets a tighter tolerance than speed.
  it('uses a 15% tolerance, tighter than gateSpeed, calibrated to its own lower observed spread', () => {
    expect(PERFORMANCE_REGRESSION_TOLERANCE).toBe(0.15);
    expect(PERFORMANCE_REGRESSION_TOLERANCE).toBeLessThan(SPEED_REGRESSION_TOLERANCE);
  });

  it('passes at 158s, the highest sumRunnerSeconds among the baseline sampleRuns (top of observed normal variance)', () => {
    const result = checkPerformanceRegression(158, baseline);
    expect(result.pass).toBe(true);
  });

  it('fails a genuine 40% compute regression', () => {
    const result = checkPerformanceRegression(154.6 * 1.4, baseline);
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('gate performance regressed');
  });
});

describe('checkImageSizeRegression', () => {
  it('is a no-op pass when the baseline has not measured image size yet', () => {
    const result = checkImageSizeRegression(999_999_999, baseline);
    expect(result.pass).toBe(true);
    expect(result.reason).toContain('no-op');
  });

  it('fails when image size exceeds the measured baseline + tolerance', () => {
    const measuredBaseline: GateBaseline = {
      ...baseline,
      gatePerformance: {
        ...baseline.gatePerformance,
        dockerImageSize: { bytes: 1_000_000_000 },
      },
    };
    const result = checkImageSizeRegression(1_700_000_000, measuredBaseline);
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('gate performance regressed');
  });

  it('passes when image size is within tolerance of the measured baseline', () => {
    const measuredBaseline: GateBaseline = {
      ...baseline,
      gatePerformance: {
        ...baseline.gatePerformance,
        dockerImageSize: { bytes: 1_000_000_000 },
      },
    };
    const result = checkImageSizeRegression(1_200_000_000, measuredBaseline);
    expect(result.pass).toBe(true);
  });
});

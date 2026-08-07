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
  computeMaxDeviationFraction,
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

describe('computeMaxDeviationFraction', () => {
  it('returns 0 when every sample equals the mean', () => {
    expect(computeMaxDeviationFraction([100, 100, 100])).toBe(0);
  });

  it('returns the largest fractional distance from the mean', () => {
    // mean = 100; deviations are 0%, +10%, -10% -- the max is 0.1 either way.
    expect(computeMaxDeviationFraction([100, 110, 90])).toBeCloseTo(0.1, 10);
  });

  it('is driven by the single furthest outlier, not an average of deviations', () => {
    // mean = 104; deviations are ~0.96%, ~0.96%, ~1.92% -- driven by the 106.
    expect(computeMaxDeviationFraction([103, 103, 106])).toBeCloseTo(2 / 104, 10);
  });

  it('throws on an empty sample set rather than dividing by zero', () => {
    expect(() => computeMaxDeviationFraction([])).toThrow('requires at least one sample');
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
  // `?? 0` never fires in practice — the test below asserts the figure is a
  // number — and a 0 baseline would fail the slowdown expectations loudly.
  const baselineLongestJobSeconds = committed.gateSpeed.averageLongestJobDurationSeconds ?? 0;
  const baselineSumRunnerSeconds = committed.gatePerformance.runnerMinutes.averagePerRunSeconds;

  it('carries the gating speed figure the guard reads', () => {
    expect(typeof committed.gateSpeed.averageLongestJobDurationSeconds).toBe('number');
  });

  // toon#153: the recorded rationale documents the tolerance the code
  // actually enforces; a hand-edit of one without the other should fail
  // this test rather than silently drift.
  it('records the ratcheted tolerances next to the numbers they were derived from', () => {
    expect(committed.gateSpeed.regressionTolerance).toBe(SPEED_REGRESSION_TOLERANCE);
    expect(committed.gatePerformance.runnerMinutes.regressionTolerance).toBe(
      PERFORMANCE_REGRESSION_TOLERANCE,
    );
  });

  // The regression this guard exists to catch: a change that genuinely makes
  // a gate job much slower must still go red against the committed numbers.
  it('still fails a genuine 2x slowdown of the longest job', () => {
    expect(checkSpeedRegression(baselineLongestJobSeconds * 2, committed).pass).toBe(false);
    expect(checkPerformanceRegression(baselineSumRunnerSeconds * 2, committed).pass).toBe(false);
  });

  // toon#153: a genuine 40% compute regression must still fail even at the
  // tighter, ratcheted tolerances -- the whole point of tightening them.
  it('fails a 40% slowdown of the longest job or of summed runner-seconds', () => {
    expect(checkSpeedRegression(baselineLongestJobSeconds * 1.4, committed).pass).toBe(false);
    expect(checkPerformanceRegression(baselineSumRunnerSeconds * 1.4, committed).pass).toBe(false);
  });

  // toon#153: the highest individual sampleRuns figures (112s longest job,
  // 158s summed runner-seconds) must still pass -- the ratcheted tolerances
  // must never false-FAIL on the normal variance they were calibrated against.
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

  // toon#173: the toon#153 regressionToleranceRationale strings asserted a
  // "3x"/"4x" spread-to-tolerance ratio in prose, computed once against the
  // sampleRuns of the day and then left to drift -- by the time #157 merged,
  // the actual gating run (120.0s/164.0s) sat outside every sampleRun the
  // rationale cited. This block recomputes the observed spread from the
  // committed sampleRuns on every test run, so a future hand-edit of
  // sampleRuns without updating observedMaxDeviationFraction (or a tolerance
  // edit that no longer clears the observed spread) fails loudly instead of
  // silently going stale again.
  describe('the committed regressionToleranceRationale is falsifiable', () => {
    const sampleRuns = committed.sampleRuns ?? [];

    it('gateSpeed.observedMaxDeviationFraction matches what the committed sampleRuns actually produce', () => {
      const observed = computeMaxDeviationFraction(sampleRuns.map((run) => run.longestJobSeconds));
      expect(committed.gateSpeed.observedMaxDeviationFraction).toBeCloseTo(observed, 6);
      // The whole point of the ratchet: the enforced tolerance must still
      // clear the observed spread, or normal variance would false-FAIL.
      expect(SPEED_REGRESSION_TOLERANCE).toBeGreaterThan(observed);
    });

    it('gatePerformance.runnerMinutes.observedMaxDeviationFraction matches what the committed sampleRuns actually produce', () => {
      const observed = computeMaxDeviationFraction(sampleRuns.map((run) => run.sumRunnerSeconds));
      expect(committed.gatePerformance.runnerMinutes.observedMaxDeviationFraction).toBeCloseTo(
        observed,
        6,
      );
      expect(PERFORMANCE_REGRESSION_TOLERANCE).toBeGreaterThan(observed);
    });
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
});

// toon#153 ratcheted the two job-duration bands down from the span-era 50%,
// each to a figure calibrated against its own metric's observed spread. Pin the
// values so an edit that widens one back toward 50% fails a test instead of
// silently regressing the guard.
describe('the ratcheted regression tolerances', () => {
  it('gates the longest job at 20%, not the retired 50% span-era value', () => {
    expect(SPEED_REGRESSION_TOLERANCE).toBe(0.2);
  });

  // Runner-seconds' observed spread (~3.6%) is tighter than the longest-job
  // figure's (~6.2%), so it earns the tighter of the two bands.
  it('gates runner-seconds tighter still, at 15%', () => {
    expect(PERFORMANCE_REGRESSION_TOLERANCE).toBe(0.15);
    expect(PERFORMANCE_REGRESSION_TOLERANCE).toBeLessThan(SPEED_REGRESSION_TOLERANCE);
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

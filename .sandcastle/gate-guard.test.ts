import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkImageSizeRegression,
  checkLintCeiling,
  checkMeasurementCoverage,
  checkParallelismAssumption,
  checkPerformanceRegression,
  checkRequiredJobsMeasured,
  checkSpeedRegression,
  computeJobDurationsSeconds,
  computeMaxDeviationFraction,
  PARALLELISM_CREATION_SKEW_TOLERANCE_SECONDS,
  PERFORMANCE_REGRESSION_TOLERANCE,
  resolveExcludedJobNames,
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

// The frozen file the guard reads at runtime. Tests assert against the
// committed JSON itself rather than a hand-copied transcription of its numbers,
// so a recapture cannot leave them asserting figures the data no longer has.
const committed = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'gate-baseline.json'), 'utf8'),
) as GateBaseline;

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

  // toon#153: the highest individual sampleRuns figures must still pass -- the
  // ratcheted tolerances must never false-FAIL on the normal variance they
  // were calibrated against. The figures are read from the committed
  // sampleRuns rather than named here, so a recapture (as in toon#173) cannot
  // leave this comment asserting a maximum the data no longer contains.
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

    // The averages the guard gates against must themselves be the mean of the
    // committed sampleRuns. Without this, observedMaxDeviationFraction could
    // still agree with the samples while the mean it is a spread AROUND had
    // drifted away from them -- the same class of defect one level up.
    it('gates against averages that are the mean of the committed sampleRuns', () => {
      const mean = (values: readonly number[]) =>
        values.reduce((sum, value) => sum + value, 0) / values.length;
      expect(baselineLongestJobSeconds).toBeCloseTo(
        mean(sampleRuns.map((run) => run.longestJobSeconds)),
        6,
      );
      expect(baselineSumRunnerSeconds).toBeCloseTo(
        mean(sampleRuns.map((run) => run.sumRunnerSeconds)),
        6,
      );
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

  // Runner-seconds' observed spread is tighter than the longest-job figure's,
  // so it earns the tighter of the two bands. The two spreads themselves live
  // in gate-baseline.json as observedMaxDeviationFraction and are recomputed
  // from sampleRuns by the "falsifiable" block above (toon#173) rather than
  // quoted here, where they would go stale on the next recapture.
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

// toon#154: checkSpeedRegression assumes ci.yml's gated jobs run in parallel.
// The jobs API has no `needs:` field, so this check infers serialisation from
// how far apart the measured jobs were CREATED -- a figure runner queue depth
// cannot move, so it cannot resurrect the toon#150/toon#151 false FAIL.
describe('checkParallelismAssumption', () => {
  it('passes a genuinely parallel run: both jobs created together, span equals the longest job', () => {
    const durations = computeJobDurationsSeconds([
      {
        name: 'build',
        created_at: '2026-08-13T00:00:00Z',
        started_at: '2026-08-13T00:00:03Z',
        completed_at: '2026-08-13T00:01:57Z',
      },
      {
        name: 'Devbox Environment Validation',
        created_at: '2026-08-13T00:00:00Z',
        started_at: '2026-08-13T00:00:04Z',
        completed_at: '2026-08-13T00:00:53Z',
      },
    ]);

    const result = checkParallelismAssumption(durations);
    expect(result.pass).toBe(true);
  });

  // The scenario the issue describes: someone adds `needs:` between the two
  // gated jobs. Real wall-clock roughly doubles (build then devbox run back
  // to back) while neither longestJobSeconds nor sumRunnerSeconds moves --
  // exactly what checkSpeedRegression and checkPerformanceRegression cannot
  // see on their own.
  it('fails when the gated jobs run back-to-back instead of in parallel', () => {
    const durations = computeJobDurationsSeconds([
      {
        name: 'build',
        created_at: '2026-08-13T00:00:00Z',
        started_at: '2026-08-13T00:00:03Z',
        completed_at: '2026-08-13T00:01:57Z', // 114s
      },
      {
        // GitHub does not create a `needs:`-gated job until its dependency
        // finishes, so this job's OWN queue gap (created_at -> started_at)
        // stays small even though it started 114s after build did.
        name: 'Devbox Environment Validation',
        created_at: '2026-08-13T00:01:57Z',
        started_at: '2026-08-13T00:01:59Z',
        completed_at: '2026-08-13T00:02:48Z', // 49s
      },
    ]);

    // The blind spot toon#154 is about: both gated figures look unchanged...
    expect(durations.longestJobSeconds).toBe(114);
    expect(checkSpeedRegression(durations.longestJobSeconds, baseline).pass).toBe(true);
    expect(checkPerformanceRegression(durations.sumRunnerSeconds, baseline).pass).toBe(true);
    // ...but the parallelism check catches the doubled span.
    const result = checkParallelismAssumption(durations);
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('no longer appear to run in parallel');
  });

  // toon#150/toon#151's exact regression: a saturated runner pool inflates
  // the span for a reason that has nothing to do with the job DAG. This must
  // still pass, or the parallelism check would resurrect the false FAIL #151
  // fixed. Both jobs were created at the same instant -- queueing delayed
  // their starts, not their creation -- so the skew gate sees a parallel run
  // no matter how deep the queue got.
  it('passes a queue-saturated parallel run instead of false-FAILing (toon#150/toon#151)', () => {
    const durations = computeJobDurationsSeconds([
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

    expect(durations.maxCreationSkewSeconds).toBe(0);
    const result = checkParallelismAssumption(durations);
    expect(result.pass).toBe(true);
  });

  // The band the span-with-queue-threshold revision of this check got wrong:
  // a genuinely parallel run whose LONGEST job waits 12-30s for a runner. The
  // span outgrows longestJob * 1.1 (132s vs 125.4s here) while summed queue
  // time (22s) stays under the old 30s skip threshold, so the span heuristic
  // hard-FAILed an unrelated commit and blamed a `needs:` that does not
  // exist. Creation skew is 0 -- both jobs were created together -- so the
  // check must pass this run.
  it('passes a parallel run whose longest job queued 12-30s (the span-heuristic false-FAIL band)', () => {
    const durations = computeJobDurationsSeconds([
      {
        name: 'build',
        created_at: '2026-08-13T00:00:00Z',
        started_at: '2026-08-13T00:00:20Z',
        completed_at: '2026-08-13T00:02:14Z', // 114s, queued 20s
      },
      {
        name: 'Devbox Environment Validation',
        created_at: '2026-08-13T00:00:00Z',
        started_at: '2026-08-13T00:00:02Z',
        completed_at: '2026-08-13T00:00:51Z', // 49s, queued 2s
      },
    ]);

    // The exact shape of the band: span exceeds longestJob * 1.1 while
    // summed queue sits between the 10%-of-longest slack and the old 30s
    // threshold. Fully overlapping executions nonetheless.
    expect(durations.totalWallClockSeconds).toBe(132);
    expect(durations.longestJobSeconds).toBe(114);
    expect(durations.totalQueueSeconds).toBe(22);
    expect(durations.maxCreationSkewSeconds).toBe(0);

    const result = checkParallelismAssumption(durations);
    expect(result.pass).toBe(true);
  });

  // The skew tolerance separates fan-out jitter (~1-2s) from a real `needs:`
  // edge (creation delayed by the dependency's full runtime). Pin it so an
  // edit cannot quietly widen it past the shortest gated job's duration,
  // which would let a real serialisation hide inside the tolerance.
  it('keeps the creation-skew tolerance above jitter and far below a gated job duration', () => {
    expect(PARALLELISM_CREATION_SKEW_TOLERANCE_SECONDS).toBe(15);
  });

  it('skips rather than guesses when there is no created_at data to measure creation skew', () => {
    const durations = computeJobDurationsSeconds([
      { name: 'build', started_at: '2026-08-13T00:00:00Z', completed_at: '2026-08-13T00:01:54Z' },
      {
        name: 'Devbox Environment Validation',
        started_at: '2026-08-13T00:01:54Z',
        completed_at: '2026-08-13T00:02:43Z',
      },
    ]);

    // The fixture is back-to-back, so a span-based check would have FAILED it
    // on no evidence; without created_at there is nothing to judge.
    expect(durations.maxCreationSkewSeconds).toBeUndefined();
    const result = checkParallelismAssumption(durations);
    expect(result.pass).toBe(true);
    expect(result.reason).toContain('skipped');
  });

  // The committed samples predate creation-skew capture, so replaying them
  // exercises the skip branch: a run whose skew cannot be measured must never
  // fail. Deliberately no span-vs-longest-job assertion here -- the five
  // samples happen to have identical spans, but a parallel run whose longest
  // job queued would not, and pinning that equality is the span heuristic
  // this check exists to avoid.
  it('skips, rather than fails, every sampleRun in the committed gate-baseline.json', () => {
    const sampleRuns = committed.sampleRuns ?? [];
    expect(sampleRuns.length).toBeGreaterThan(0);
    for (const run of sampleRuns) {
      const result = checkParallelismAssumption({
        byName: {},
        longestJobSeconds: run.longestJobSeconds,
        sumRunnerSeconds: run.sumRunnerSeconds,
        totalWallClockSeconds: run.totalRunSpanSeconds,
        totalQueueSeconds: run.queueSeconds,
      });
      expect(result.pass).toBe(true);
      expect(result.reason).toContain('skipped');
    }
  });
});

// toon#216. The Solana settlement redemption proof is a ci.yml job that runs
// only on change sets touching the settlement surface, and it is excluded from
// the frozen figures by name. These two functions are what keep that exclusion
// from becoming a hole in the ceiling.
describe('resolveExcludedJobNames', () => {
  const withExclusions: GateBaseline = {
    ...baseline,
    gateSpeed: {
      ...baseline.gateSpeed,
      excludedJobNames: ['Solana settlement redemption proof'],
    },
  };

  it('unions the frozen baseline exclusions with the guard job passed in by the workflow', () => {
    expect(resolveExcludedJobNames(withExclusions, 'Gate speed guard')).toEqual([
      'Solana settlement redemption proof',
      'Gate speed guard',
    ]);
  });

  it('does not duplicate the guard job when the baseline already names it', () => {
    const both: GateBaseline = {
      ...baseline,
      gateSpeed: {
        ...baseline.gateSpeed,
        excludedJobNames: ['Gate speed guard', 'Solana settlement redemption proof'],
      },
    };
    expect(resolveExcludedJobNames(both, 'Gate speed guard')).toEqual([
      'Gate speed guard',
      'Solana settlement redemption proof',
    ]);
  });

  it('still excludes the guard job when the baseline lists no exclusions', () => {
    expect(resolveExcludedJobNames(baseline, 'Gate speed guard')).toEqual(['Gate speed guard']);
  });

  it('excludes nothing when neither source names anything', () => {
    expect(resolveExcludedJobNames(baseline, undefined)).toEqual([]);
    expect(resolveExcludedJobNames(baseline, '')).toEqual([]);
  });
});

describe('checkRequiredJobsMeasured', () => {
  const required: GateBaseline = {
    ...baseline,
    gateSpeed: {
      ...baseline.gateSpeed,
      requiredMeasuredJobNames: ['build', 'Devbox Environment Validation'],
    },
  };

  it('passes when every baselined job was measured', () => {
    const result = checkRequiredJobsMeasured(
      ['build', 'Devbox Environment Validation', 'no-op merge guard'],
      required,
    );
    expect(result.pass).toBe(true);
  });

  // The failure this exists for: an exclusion (or a rename, or a job that
  // stopped running) quietly takes the expensive job out of the measurement,
  // and the remaining cheap jobs sail under a ceiling captured on all of them.
  it('fails when an excluded/renamed/absent job takes gated work out of the measurement', () => {
    const result = checkRequiredJobsMeasured(['Devbox Environment Validation'], required);
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('build');
    expect(result.reason).toContain('recapture');
  });

  it('fails loudly when the baseline carries no required list at all', () => {
    expect(checkRequiredJobsMeasured(['build'], baseline).pass).toBe(false);
    const empty: GateBaseline = {
      ...baseline,
      gateSpeed: { ...baseline.gateSpeed, requiredMeasuredJobNames: [] },
    };
    expect(checkRequiredJobsMeasured(['build'], empty).pass).toBe(false);
  });
});

describe("the committed baseline's measured-job bookkeeping", () => {
  it('requires the two jobs its frozen figures were captured on', () => {
    expect(committed.gateSpeed.requiredMeasuredJobNames).toEqual([
      'build',
      'Devbox Environment Validation',
    ]);
  });

  it('excludes the guard job and the conditional Solana proof, and nothing else', () => {
    expect(committed.gateSpeed.excludedJobNames).toEqual([
      'Gate speed/performance no-regression guard',
      'Solana settlement redemption proof',
    ]);
  });

  // The one combination that would defeat the ceiling silently: excluding a job
  // the frozen numbers were measured on. Belt to checkRequiredJobsMeasured's
  // braces -- that check fires in CI, this one fires on the committed file.
  it('never excludes a job it also requires to be measured', () => {
    const excluded = committed.gateSpeed.excludedJobNames ?? [];
    const requiredNames = committed.gateSpeed.requiredMeasuredJobNames ?? [];
    expect(requiredNames.filter((name) => excluded.includes(name))).toEqual([]);
  });

  it('replays a real run: build + devbox + no-op-merge measured, guard and proof excluded', () => {
    // Job rows as the API returned them for run 32028945650 (push, 3590bb3),
    // plus a proof job at its measured 94s. The proof and the guard must drop
    // out; what remains must still be inside both frozen ceilings.
    const apiJobs = [
      { name: 'build', started_at: '2026-08-17T12:15:30Z', completed_at: '2026-08-17T12:17:20Z', created_at: '2026-08-17T12:15:28Z' },
      { name: 'Devbox Environment Validation', started_at: '2026-08-17T12:15:30Z', completed_at: '2026-08-17T12:16:18Z', created_at: '2026-08-17T12:15:28Z' },
      { name: 'no-op merge guard', started_at: '2026-08-17T12:15:30Z', completed_at: '2026-08-17T12:15:36Z', created_at: '2026-08-17T12:15:28Z' },
      { name: 'Solana settlement redemption proof', started_at: '2026-08-17T12:17:22Z', completed_at: '2026-08-17T12:18:56Z', created_at: '2026-08-17T12:17:20Z' },
      { name: 'Gate speed/performance no-regression guard', started_at: '2026-08-17T12:17:24Z', completed_at: '2026-08-17T12:17:56Z', created_at: '2026-08-17T12:17:20Z' },
    ];

    const measured = selectMeasurableJobs(apiJobs, {
      excludeNames: resolveExcludedJobNames(
        committed,
        'Gate speed/performance no-regression guard',
      ),
    });
    expect(measured.map((job) => job.name)).toEqual([
      'build',
      'Devbox Environment Validation',
      'no-op merge guard',
    ]);

    const durations = computeJobDurationsSeconds(measured);
    expect(checkRequiredJobsMeasured(Object.keys(durations.byName), committed).pass).toBe(true);
    expect(checkSpeedRegression(durations.longestJobSeconds, committed).pass).toBe(true);
    expect(checkPerformanceRegression(durations.sumRunnerSeconds, committed).pass).toBe(true);
    // Without the exclusion, the proof's `needs: build` creation lag would also
    // have tripped the parallelism check -- the second reason it cannot simply
    // be folded into the measured set.
    expect(checkParallelismAssumption(durations).pass).toBe(true);
  });
});

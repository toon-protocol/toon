// Pure comparison functions for the gate no-regression guard
// (toon-protocol/toon#117, part of toon-protocol/toon-meta#210).
//
// These read the frozen `.sandcastle/gate-baseline.json` (captured by #116)
// as the sole source of truth, never a live/recomputed threshold, so the
// same commit always earns the same verdict (no false FAIL from run-to-run
// noise, no false PASS from a silently-raised ceiling).

export interface GateBaseline {
  gateSpeed: {
    // The GATING figure: the average duration of the single longest job in a
    // run (the run's critical path if runners were always instantly
    // available). See checkSpeedRegression for why the span is not gated.
    averageLongestJobDurationSeconds?: number;
    // INFORMATIONAL ONLY (toon#151): the observed start-to-finish span of a
    // run. It includes runner queue time, so it is recorded for context but
    // never compared against.
    averageTotalRunDurationSeconds: number;
    // DOCUMENTATION (toon#153): the band this metric is gated at, recorded
    // beside the number it was derived from (with a `regressionToleranceRationale`
    // spelling out the derivation). The guard enforces the constant below; a
    // test pins the two in sync so neither can be edited alone.
    regressionTolerance?: number;
    // DOCUMENTATION (toon#173): computeMaxDeviationFraction(sampleRuns'
    // longestJobSeconds), recorded so a test can recompute it from the
    // committed sampleRuns and fail if this drifts out of sync with them --
    // the failure mode that shipped a stale 3x/4x claim in toon#153.
    observedMaxDeviationFraction?: number;
  };
  gatePerformance: {
    runnerMinutes: {
      averagePerRunSeconds: number;
      // DOCUMENTATION only, as above.
      regressionTolerance?: number;
      // DOCUMENTATION (toon#173), as above.
      observedMaxDeviationFraction?: number;
    };
    dockerImageSize: {
      bytes?: number;
    };
  };
  gateCorrectness: {
    lint: {
      maxWarningsCeiling: number;
    };
  };
  // The individual runs the averages above were computed from (toon#151);
  // used by tests to pin behaviour at the top of observed normal variance
  // without hand-copying numbers that could drift from gate-baseline.json.
  sampleRuns?: ReadonlyArray<{
    longestJobSeconds: number;
    sumRunnerSeconds: number;
    // toon#173: which trigger produced this run. gate-regression-guard gates
    // pull_request runs too, not just push-to-main (ci.yml:135-137 -- the
    // guard job has no event filter of its own, and the workflow triggers on
    // both events), so the sample set is no longer push-only -- recorded so
    // that is legible from the data instead of asserted in prose.
    event?: string;
  }>;
}

export interface GuardResult {
  pass: boolean;
  reason: string;
}

// Each tolerance is a band around a frozen baseline average, sized from that
// metric's OWN run-to-run spread across gate-baseline.json's sampleRuns: wide
// enough that normal variance can never false-FAIL, tight enough that a real
// compute regression still goes red. gate-baseline.json records each band
// beside the number it was derived from, under `regressionTolerance` /
// `regressionToleranceRationale`.

// 50% was sized for the span-era gateSpeed metric, which absorbed runner queue
// depth and could legitimately swing tens of seconds run-to-run (the toon#150
// incident: a 402.0s span measured against 147.0s of actual compute). toon#151
// replaced that metric with a job duration but deliberately left this number
// untouched: the false FAIL it fixed came from measuring the wrong quantity,
// and widening a tolerance until it stops firing would have traded a false FAIL
// for a false PASS. toon#153 ratcheted the two job-duration metrics below and
// left 50% here, where it still fits: dockerImageSize is an unrelated and
// still-unmeasured quantity, with no sample spread yet to ratchet against.
export const IMAGE_SIZE_REGRESSION_TOLERANCE = 0.5;

// toon#153: averageLongestJobDurationSeconds is a job duration, not a
// queue-inflated span, so it is far steadier than the metric 50% was sized
// for. toon#173: the actual spread-to-tolerance ratio is COMPUTED from the
// committed sampleRuns, not hand-copied into this comment where it could
// silently drift out of sync with them (as it did in toon#153, whose "3x"/
// "4x" claim had gone stale by the time this fix landed) -- see
// gate-baseline.json's gateSpeed.regressionToleranceRationale for the current
// numbers and gate-guard.test.ts's "regressionToleranceRationale is
// falsifiable" block for the check that recomputes it every run.
export const SPEED_REGRESSION_TOLERANCE = 0.2;

// toon#153: runner-seconds' observed spread is steadier than the longest-job
// figure's, so it earns the tighter of the two bands. toon#173: see
// SPEED_REGRESSION_TOLERANCE's comment above -- same falsifiability fix,
// same reason the ratio itself isn't restated here.
export const PERFORMANCE_REGRESSION_TOLERANCE = 0.15;

// toon#173: the max fractional deviation of any sample from the mean of all
// samples -- the "observed spread" that regressionToleranceRationale strings
// describe in prose. Computed from data so the claim can be checked against
// gate-baseline.json's sampleRuns instead of trusted as an assertion, which is
// how toon#153's rationale went stale (recorded a real 2026-08-05 ratio, then
// kept asserting it after the underlying sampleRuns no longer supported it).
export function computeMaxDeviationFraction(samples: readonly number[]): number {
  if (samples.length === 0) {
    throw new Error('computeMaxDeviationFraction requires at least one sample');
  }
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  return Math.max(...samples.map((value) => Math.abs(value - mean) / mean));
}

const MAX_WARNINGS_PATTERN = /--max-warnings[= ](\d+)/;

export function checkLintCeiling(lintScript: string, baseline: GateBaseline): GuardResult {
  const match = MAX_WARNINGS_PATTERN.exec(lintScript);
  if (!match) {
    return {
      pass: false,
      reason: `lint script "${lintScript}" has no --max-warnings ceiling to compare against the frozen baseline`,
    };
  }

  const ceiling = Number(match[1]);
  const frozen = baseline.gateCorrectness.lint.maxWarningsCeiling;
  if (ceiling > frozen) {
    return {
      pass: false,
      reason: `lint --max-warnings ceiling ${ceiling} exceeds the frozen baseline ceiling ${frozen} — raise it only via a new gate-baseline.json capture, not silently`,
    };
  }

  return {
    pass: true,
    reason: `lint --max-warnings ceiling ${ceiling} <= frozen baseline ceiling ${frozen}`,
  };
}

export interface CiJobTiming {
  name: string;
  started_at: string;
  completed_at: string;
  // Present on the GitHub jobs API; absent in hand-written fixtures.
  created_at?: string;
  run_attempt?: number;
}

export interface JobDurations {
  byName: Record<string, number>;
  // GATING: the longest single job. With no queueing this IS the run's
  // wall-clock (ci.yml's measured jobs run in parallel), and it is immune to
  // how busy the shared runner pool happens to be. That parallelism is an
  // assumption, not something this figure alone can see -- checkParallelismAssumption
  // (toon#154) checks it using the other figures on this type.
  longestJobSeconds: number;
  // GATING: total compute across the run.
  sumRunnerSeconds: number;
  // INFORMATIONAL: max(completed) - min(started). Absorbs the gaps between
  // jobs that are waiting for a free runner, so it is reported but not gated.
  totalWallClockSeconds: number;
  // INFORMATIONAL: summed per-job queue time (started_at - created_at), i.e.
  // how much of the span was GitHub scheduling rather than this repo's work.
  // Undefined when the fixture/response carries no `created_at`.
  totalQueueSeconds?: number;
}

// A job that has not finished yet (notably the guard's own job, which is still
// running when it reads the API) has no duration to measure.
export function hasCompletedTimings(job: {
  started_at: string | null;
  completed_at: string | null;
}): boolean {
  return job.started_at !== null && job.completed_at !== null;
}

export interface JobSelection {
  // Display names to drop — in practice the guard's own job, so the guard
  // never measures itself.
  excludeNames?: readonly string[];
  // Keep only jobs stamped with this run attempt, so a re-run measures the
  // attempt that is actually executing (toon#151).
  attempt?: number;
}

export function selectMeasurableJobs<
  T extends { name: string; started_at: string | null; completed_at: string | null; run_attempt?: number },
>(jobs: readonly T[], selection: JobSelection = {}): T[] {
  const excluded = new Set(selection.excludeNames ?? []);
  return jobs.filter((job) => {
    if (!hasCompletedTimings(job)) return false;
    if (excluded.has(job.name)) return false;
    if (
      selection.attempt !== undefined &&
      job.run_attempt !== undefined &&
      job.run_attempt !== selection.attempt
    ) {
      return false;
    }
    return true;
  });
}

export function computeJobDurationsSeconds(jobs: CiJobTiming[]): JobDurations {
  const byName: Record<string, number> = {};
  let earliestStart: number | undefined;
  let latestCompletion: number | undefined;
  let sumRunnerSeconds = 0;
  let longestJobSeconds = 0;
  let totalQueueSeconds: number | undefined;

  for (const job of jobs) {
    const startedMs = new Date(job.started_at).getTime();
    const completedMs = new Date(job.completed_at).getTime();
    const durationSeconds = (completedMs - startedMs) / 1000;

    byName[job.name] = durationSeconds;
    sumRunnerSeconds += durationSeconds;
    if (durationSeconds > longestJobSeconds) {
      longestJobSeconds = durationSeconds;
    }

    if (job.created_at !== undefined) {
      // A job carried over from an earlier attempt keeps its original
      // start/finish but gets the NEW attempt's created_at, which makes this
      // negative. Clamp at zero: it is a display figure, not a gate.
      const queueSeconds = Math.max(0, (startedMs - new Date(job.created_at).getTime()) / 1000);
      totalQueueSeconds = (totalQueueSeconds ?? 0) + queueSeconds;
    }

    if (earliestStart === undefined || startedMs < earliestStart) {
      earliestStart = startedMs;
    }
    if (latestCompletion === undefined || completedMs > latestCompletion) {
      latestCompletion = completedMs;
    }
  }

  const totalWallClockSeconds =
    earliestStart !== undefined && latestCompletion !== undefined
      ? (latestCompletion - earliestStart) / 1000
      : 0;

  return { byName, longestJobSeconds, sumRunnerSeconds, totalWallClockSeconds, totalQueueSeconds };
}

// Zero measured jobs makes every duration 0, which would sail under every
// threshold. A filter that matched nothing is a broken guard, not a fast run,
// so it fails rather than silently passing.
export function checkMeasurementCoverage(measuredJobCount: number): GuardResult {
  if (measuredJobCount === 0) {
    return {
      pass: false,
      reason:
        'no completed jobs to measure — the jobs API response was empty or every job was filtered out; the guard cannot vouch for this run',
    };
  }

  return { pass: true, reason: `measured ${measuredJobCount} completed job(s)` };
}

// toon#151: this used to compare the run's wall-clock SPAN
// (max(completed) - min(started)) against the baseline. The span includes the
// time jobs spend queued for a free runner, which is a property of how busy
// the org's CI is at that moment, not of the commit under test. It produced
// hard false FAILs -- e.g. toon#150 measured a 402.0s span whose actual
// compute was 147.0s summed / 93.0s longest job, both comfortably inside
// baseline. What is gated now is the longest single job: with a free runner
// pool that IS the run's wall-clock, because ci.yml's measured jobs run in
// parallel, and it cannot be inflated by queue depth. A change that genuinely
// makes the gate slower makes some job slower, and is still caught.
export function checkSpeedRegression(
  actualLongestJobSeconds: number,
  baseline: GateBaseline,
  tolerance: number = SPEED_REGRESSION_TOLERANCE,
): GuardResult {
  const baselineSeconds = baseline.gateSpeed.averageLongestJobDurationSeconds;

  // Fail loudly rather than silently passing: a baseline file without the
  // gating figure is a mis-capture, not a licence to skip the check.
  if (baselineSeconds === undefined) {
    return {
      pass: false,
      reason:
        'gate-baseline.json has no gateSpeed.averageLongestJobDurationSeconds — recapture the baseline (see its `method` field) rather than leaving the speed guard unthresholded',
    };
  }

  const allowedSeconds = baselineSeconds * (1 + tolerance);

  if (actualLongestJobSeconds > allowedSeconds) {
    return {
      pass: false,
      reason: `gate speed regressed: longest job ${actualLongestJobSeconds.toFixed(1)}s exceeds the frozen baseline ${baselineSeconds}s + ${tolerance * 100}% tolerance (${allowedSeconds.toFixed(1)}s). This measures job execution only, never runner queue time, so re-running will reproduce it — use "Re-run all jobs" to re-measure.`,
    };
  }

  return {
    pass: true,
    reason: `gate speed OK: longest job ${actualLongestJobSeconds.toFixed(1)}s within baseline ${baselineSeconds}s + ${tolerance * 100}% tolerance (${allowedSeconds.toFixed(1)}s)`,
  };
}

// toon#154: checkSpeedRegression's validity rests on an assumption it cannot
// see -- that ci.yml's gated jobs stay mutually independent, so the longest
// of them really is the run's critical path. The jobs API has no `needs:`
// field, so this infers the DAG from timings already computed for the other
// checks rather than parsing the workflow YAML (option 2 of toon#154's three,
// chosen over parsing ci.yml for `needs:` -- more precise but couples the
// guard to the workflow file for a check the timings already support -- and
// over leaving the assumption as a comment only, which stays silent exactly
// when it matters).
//
// Under real parallelism with negligible queue time, the run's wall-clock
// span is the longest job's own duration: every sampleRun in gate-baseline.json
// agrees (span - longestJob is exactly 0 in all five). Serialising two gated
// jobs with `needs:` grows the span by roughly the OTHER job's duration while
// longestJobSeconds and sumRunnerSeconds both stay flat -- the exact blind
// spot this check exists to close -- so a span that outgrows the longest job
// by more than job-start skew, on a run where queueing cannot explain the
// gap, means the jobs did not overlap.
//
// This is deliberately queue-gated: it only evaluates when totalQueueSeconds
// is small enough that a saturated runner pool (toon#150/toon#151) cannot be
// the explanation for a wide span. Re-triggering that false FAIL here would
// undo #151's fix, so an ambiguous run (heavy queueing, or no created_at data
// to measure queueing at all) is reported as passing rather than guessed at.
export const PARALLELISM_QUEUE_NEGLIGIBLE_SECONDS = 30;

// How far the span may exceed the longest job once queueing is ruled out --
// covers ordinary job-start skew (the committed sampleRuns show 0s of it, so
// this is a comfortable margin, not a fitted one) without being wide enough
// to also cover a second job's duration if the first job it depends on
// finished promptly.
export const PARALLELISM_SLACK_TOLERANCE = 0.1;

export function checkParallelismAssumption(durations: JobDurations): GuardResult {
  const { longestJobSeconds, totalWallClockSeconds, totalQueueSeconds } = durations;

  if (totalQueueSeconds === undefined) {
    return {
      pass: true,
      reason:
        'parallelism check skipped -- no created_at data to confirm queue time is negligible enough to trust the span',
    };
  }

  if (totalQueueSeconds > PARALLELISM_QUEUE_NEGLIGIBLE_SECONDS) {
    return {
      pass: true,
      reason: `parallelism check skipped -- summed queue time ${totalQueueSeconds.toFixed(1)}s exceeds the ${PARALLELISM_QUEUE_NEGLIGIBLE_SECONDS}s negligible threshold, so a wide span cannot be distinguished from runner queueing (toon#150/toon#151)`,
    };
  }

  const allowedSpanSeconds = longestJobSeconds * (1 + PARALLELISM_SLACK_TOLERANCE);
  if (totalWallClockSeconds > allowedSpanSeconds) {
    return {
      pass: false,
      reason: `gated jobs no longer appear to run in parallel: run span ${totalWallClockSeconds.toFixed(1)}s exceeds the longest job ${longestJobSeconds.toFixed(1)}s + ${PARALLELISM_SLACK_TOLERANCE * 100}% (${allowedSpanSeconds.toFixed(1)}s) while queue time was negligible (${totalQueueSeconds.toFixed(1)}s) -- check whether a \`needs:\` was added between ci.yml's gated jobs, which would make checkSpeedRegression blind to the slowdown (toon#154)`,
    };
  }

  return {
    pass: true,
    reason: `gated jobs ran in parallel: run span ${totalWallClockSeconds.toFixed(1)}s within longest job ${longestJobSeconds.toFixed(1)}s + ${PARALLELISM_SLACK_TOLERANCE * 100}% (${allowedSpanSeconds.toFixed(1)}s)`,
  };
}

export function checkPerformanceRegression(
  actualSumRunnerSeconds: number,
  baseline: GateBaseline,
  tolerance: number = PERFORMANCE_REGRESSION_TOLERANCE,
): GuardResult {
  const baselineSeconds = baseline.gatePerformance.runnerMinutes.averagePerRunSeconds;
  const allowedSeconds = baselineSeconds * (1 + tolerance);

  if (actualSumRunnerSeconds > allowedSeconds) {
    return {
      pass: false,
      reason: `gate performance regressed: runner-seconds ${actualSumRunnerSeconds.toFixed(1)}s exceeds the frozen baseline ${baselineSeconds}s + ${tolerance * 100}% tolerance (${allowedSeconds.toFixed(1)}s)`,
    };
  }

  return {
    pass: true,
    reason: `gate performance OK: runner-seconds ${actualSumRunnerSeconds.toFixed(1)}s within baseline ${baselineSeconds}s + ${tolerance * 100}% tolerance (${allowedSeconds.toFixed(1)}s)`,
  };
}

export function checkImageSizeRegression(
  actualBytes: number,
  baseline: GateBaseline,
  tolerance: number = IMAGE_SIZE_REGRESSION_TOLERANCE,
): GuardResult {
  const baselineBytes = baseline.gatePerformance.dockerImageSize.bytes;

  if (baselineBytes === undefined) {
    return {
      pass: true,
      reason: 'baseline dockerImageSize.bytes not yet measured — guard is a no-op until a real agent-image.yml run fills it in',
    };
  }

  const allowedBytes = baselineBytes * (1 + tolerance);
  if (actualBytes > allowedBytes) {
    return {
      pass: false,
      reason: `gate performance regressed: agent image size ${actualBytes} bytes exceeds the frozen baseline ${baselineBytes} bytes + ${tolerance * 100}% tolerance (${allowedBytes.toFixed(0)} bytes)`,
    };
  }

  return {
    pass: true,
    reason: `gate performance OK: agent image size ${actualBytes} bytes within baseline ${baselineBytes} bytes + ${tolerance * 100}% tolerance (${allowedBytes.toFixed(0)} bytes)`,
  };
}

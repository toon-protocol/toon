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
  };
  gatePerformance: {
    runnerMinutes: {
      averagePerRunSeconds: number;
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
}

export interface GuardResult {
  pass: boolean;
  reason: string;
}

// Single-run job-second measurements are noisy versus the 5-run baseline
// average; a same-magnitude single run can legitimately land 20-40% above the
// mean without any real regression. 50% keeps the guard from false-FAILing on
// that noise while still catching an actual regression. toon#151 deliberately
// did NOT touch this number: the false FAIL it fixed came from measuring the
// wrong quantity, and widening a tolerance until it stops firing would have
// traded a false FAIL for a false PASS.
export const DEFAULT_REGRESSION_TOLERANCE = 0.5;

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
  // how busy the shared runner pool happens to be.
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
  tolerance: number = DEFAULT_REGRESSION_TOLERANCE,
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

export function checkPerformanceRegression(
  actualSumRunnerSeconds: number,
  baseline: GateBaseline,
  tolerance: number = DEFAULT_REGRESSION_TOLERANCE,
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
  tolerance: number = DEFAULT_REGRESSION_TOLERANCE,
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

// Pure comparison functions for the gate no-regression guard
// (toon-protocol/toon#117, part of toon-protocol/toon-meta#210).
//
// These read the frozen `.sandcastle/gate-baseline.json` (captured by #116)
// as the sole source of truth, never a live/recomputed threshold, so the
// same commit always earns the same verdict (no false FAIL from run-to-run
// noise, no false PASS from a silently-raised ceiling).

export interface GateBaseline {
  gateSpeed: {
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

// Single-run wall-clock/job-second measurements are noisy versus the 5-run
// baseline average; a same-magnitude single run can legitimately land 20-40%
// above the mean without any real regression. 50% keeps the guard from
// false-FAILing on that noise while still catching an actual regression.
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
}

export interface JobDurations {
  byName: Record<string, number>;
  totalWallClockSeconds: number;
  sumRunnerSeconds: number;
}

export function computeJobDurationsSeconds(jobs: CiJobTiming[]): JobDurations {
  const byName: Record<string, number> = {};
  let earliestStart: number | undefined;
  let latestCompletion: number | undefined;
  let sumRunnerSeconds = 0;

  for (const job of jobs) {
    const startedMs = new Date(job.started_at).getTime();
    const completedMs = new Date(job.completed_at).getTime();
    const durationSeconds = (completedMs - startedMs) / 1000;

    byName[job.name] = durationSeconds;
    sumRunnerSeconds += durationSeconds;

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

  return { byName, totalWallClockSeconds, sumRunnerSeconds };
}

export function checkSpeedRegression(
  actualTotalWallClockSeconds: number,
  baseline: GateBaseline,
  tolerance: number = DEFAULT_REGRESSION_TOLERANCE,
): GuardResult {
  const baselineSeconds = baseline.gateSpeed.averageTotalRunDurationSeconds;
  const allowedSeconds = baselineSeconds * (1 + tolerance);

  if (actualTotalWallClockSeconds > allowedSeconds) {
    return {
      pass: false,
      reason: `gate speed regressed: total run wall-clock ${actualTotalWallClockSeconds.toFixed(1)}s exceeds the frozen baseline ${baselineSeconds}s + ${tolerance * 100}% tolerance (${allowedSeconds.toFixed(1)}s)`,
    };
  }

  return {
    pass: true,
    reason: `gate speed OK: total run wall-clock ${actualTotalWallClockSeconds.toFixed(1)}s within baseline ${baselineSeconds}s + ${tolerance * 100}% tolerance (${allowedSeconds.toFixed(1)}s)`,
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

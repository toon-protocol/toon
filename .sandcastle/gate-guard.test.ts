import { describe, expect, it } from 'vitest';
import {
  checkImageSizeRegression,
  checkLintCeiling,
  checkPerformanceRegression,
  checkSpeedRegression,
  computeJobDurationsSeconds,
  type GateBaseline,
} from './gate-guard';

const baseline: GateBaseline = {
  gateSpeed: {
    averageTotalRunDurationSeconds: 112,
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
  it('computes per-job duration, wall-clock span, and summed runner-seconds for parallel jobs', () => {
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
    // wall clock = latest completion (00:01:40) - earliest start (00:00:00)
    expect(result.totalWallClockSeconds).toBe(100);
    // runner-seconds = sum of both jobs' durations
    expect(result.sumRunnerSeconds).toBe(145);
  });

  it('returns zero durations for an empty job list', () => {
    const result = computeJobDurationsSeconds([]);
    expect(result.totalWallClockSeconds).toBe(0);
    expect(result.sumRunnerSeconds).toBe(0);
    expect(result.byName).toEqual({});
  });
});

describe('checkSpeedRegression', () => {
  it('passes when wall-clock is within tolerance of the baseline average', () => {
    const result = checkSpeedRegression(120, baseline);
    expect(result.pass).toBe(true);
  });

  it('fails when wall-clock exceeds baseline average + tolerance', () => {
    const result = checkSpeedRegression(112 * 1.6, baseline);
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('gate speed regressed');
  });

  it('reads the frozen baseline number, not a live threshold, for the same commit', () => {
    const first = checkSpeedRegression(112, baseline);
    const second = checkSpeedRegression(112, baseline);
    expect(first).toEqual(second);
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

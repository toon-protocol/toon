#!/usr/bin/env node
// CLI wiring for the gate no-regression guard (toon-protocol/toon#117).
//
// Subcommands:
//   lint-ceiling                  - fails if package.json's `lint` script's
//                                    --max-warnings ceiling exceeds the frozen
//                                    baseline (the ceiling must never silently rise).
//   speed-performance <jobsJson>  - fails if this run's wall-clock or summed
//                                    runner-seconds regress vs the frozen baseline.
//                                    <jobsJson> is the path to a file containing
//                                    the `gh api .../actions/runs/<id>/jobs` response.
//   image-size <bytes>            - fails if the built agent image exceeds the
//                                    frozen baseline size. No-ops until #116/#120's
//                                    placeholder dockerImageSize.bytes is filled in.
//
// Every subcommand reads `.sandcastle/gate-baseline.json` as the sole source of
// truth (never a live/recomputed threshold) so the same commit always earns the
// same verdict.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkImageSizeRegression,
  checkLintCeiling,
  checkPerformanceRegression,
  checkSpeedRegression,
  computeJobDurationsSeconds,
  type CiJobTiming,
  type GateBaseline,
  type GuardResult,
} from './gate-guard.ts';

const SANDCASTLE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SANDCASTLE_DIR, '..');

function loadBaseline(): GateBaseline {
  const raw = readFileSync(join(SANDCASTLE_DIR, 'gate-baseline.json'), 'utf8');
  return JSON.parse(raw) as GateBaseline;
}

function report(label: string, result: GuardResult): boolean {
  const status = result.pass ? 'PASS' : 'FAIL';
  console.log(`[gate-guard] ${status} (${label}): ${result.reason}`);
  return result.pass;
}

function runLintCeiling(): boolean {
  const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const lintScript = packageJson.scripts?.lint;
  if (!lintScript) {
    console.log('[gate-guard] FAIL (lint-ceiling): package.json has no "lint" script');
    return false;
  }

  return report('lint-ceiling', checkLintCeiling(lintScript, loadBaseline()));
}

interface GhJobsResponse {
  jobs: CiJobTiming[];
}

function runSpeedPerformance(jobsJsonPath: string | undefined): boolean {
  if (!jobsJsonPath) {
    console.log('[gate-guard] FAIL (speed-performance): missing required <jobsJson> path argument');
    return false;
  }

  const parsed = JSON.parse(readFileSync(jobsJsonPath, 'utf8')) as GhJobsResponse;
  const jobs = parsed.jobs.filter((job) => job.started_at && job.completed_at);
  const durations = computeJobDurationsSeconds(jobs);
  const baseline = loadBaseline();

  const speedPass = report('speed', checkSpeedRegression(durations.totalWallClockSeconds, baseline));
  const performancePass = report(
    'performance',
    checkPerformanceRegression(durations.sumRunnerSeconds, baseline),
  );

  return speedPass && performancePass;
}

function runImageSize(bytesArg: string | undefined): boolean {
  if (!bytesArg) {
    console.log('[gate-guard] FAIL (image-size): missing required <bytes> argument');
    return false;
  }

  const bytes = Number(bytesArg);
  if (!Number.isFinite(bytes)) {
    console.log(`[gate-guard] FAIL (image-size): "${bytesArg}" is not a valid byte count`);
    return false;
  }

  return report('image-size', checkImageSizeRegression(bytes, loadBaseline()));
}

function main(): void {
  const [subcommand, ...rest] = process.argv.slice(2);

  let pass: boolean;
  switch (subcommand) {
    case 'lint-ceiling':
      pass = runLintCeiling();
      break;
    case 'speed-performance':
      pass = runSpeedPerformance(rest[0]);
      break;
    case 'image-size':
      pass = runImageSize(rest[0]);
      break;
    default:
      console.log('usage: gate-guard-cli.ts <lint-ceiling|speed-performance <jobsJson>|image-size <bytes>>');
      pass = false;
  }

  process.exit(pass ? 0 : 1);
}

main();

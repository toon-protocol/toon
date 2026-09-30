// The gate, run DETERMINISTICALLY by the runner, not self-reported by the agent.
//
// The commands are those of ci.yml's `build` job, in the same order, so passing here
// means what passing there means. `run-gate.test.ts` reads ci.yml and fails when one
// drifts. A gate that runs something *similar* to CI teaches the agent the wrong lesson.
//
// One CI job is conditional: `solana-settlement-proof`, which runs only when the change
// set touches the Solana settlement surface (settlement-surface.ts decides, and fails
// safe: an unreadable or empty change set runs it). The sandbox gate makes the same
// decision from the same module over `git diff <base>...HEAD`, so a ticket that touches
// that surface has to pass the proof before a PR opens, and one that doesn't pays
// nothing. The shared sandbox image carries the Solana CLI (2.1.21, ci.yml's version) for it.

import type * as sandcastle from '@ai-hero/sandcastle';
import { decideSettlementSurface, UNKNOWN_CHANGE_SET } from './settlement-surface.ts';

type Sandbox = Awaited<ReturnType<typeof sandcastle.createSandbox>>;

export interface GateStep {
  readonly name: string;
  readonly command: string;
}

export interface GateFailure {
  readonly step: string;
  readonly command: string;
  readonly exitCode: number;
  /** Tail of combined output: enough for an agent to act on, bounded so it cannot blow a prompt. */
  readonly output: string;
}

export interface GateResult {
  readonly passed: boolean;
  readonly ran: readonly string[];
  readonly failure: GateFailure | null;
}

/** Keep fed-back output useful but bounded. A full build log is megabytes. */
const MAX_OUTPUT_CHARS = 12_000;

/**
 * ci.yml's `build` job, step for step. CI overlaps lint with the build; a sequential run
 * here runs the same commands and only loses the overlap. Typecheck follows the build
 * because cross-package imports resolve through each package's built dist/.
 */
export const BUILD_STEPS: readonly GateStep[] = [
  { name: 'lint', command: 'pnpm lint' },
  { name: 'build', command: 'pnpm -r build' },
  { name: 'typecheck', command: 'pnpm typecheck' },
  { name: 'format check', command: 'pnpm format:check' },
  { name: 'lint ceiling', command: 'npx tsx .sandcastle/gate-guard-cli.ts lint-ceiling' },
  { name: 'package tests', command: 'pnpm -r --parallel test --if-present' },
  { name: 'gate guard tests', command: 'npx vitest run .sandcastle/' },
  {
    name: 'connector contract canary',
    command:
      'pnpm --filter @toon-protocol/sdk test:integration ' +
      'tests/integration/connector-contract.test.ts ' +
      'tests/integration/connector-contract.multichain.test.ts && ' +
      'pnpm --filter @toon-protocol/sdk exec tsc -p tests/integration/tsconfig.json',
  },
];

/**
 * ci.yml's `solana-settlement-proof` job. Its "prove it actually redeemed" assertions
 * are kept: a green run that collected nothing is what SDK_REQUIRE_SOLANA=1 exists to
 * prevent.
 */
export const SOLANA_PROOF_STEP: GateStep = {
  name: 'solana settlement proof',
  command:
    'SDK_REQUIRE_SOLANA=1 NO_COLOR=1 FORCE_COLOR=0 ' +
    'pnpm --filter @toon-protocol/sdk test:integration ' +
    'tests/integration/solana-claim-redeem.integration.test.ts > /tmp/solana-proof.log 2>&1; ' +
    'status=$?; cat /tmp/solana-proof.log; test "$status" -eq 0 && ' +
    "sed -r 's/\\x1b\\[[0-9;]*[a-zA-Z]//g' /tmp/solana-proof.log > /tmp/solana-proof.plain && " +
    "grep -qE 'Tests +5 passed \\(5\\)' /tmp/solana-proof.plain && " +
    "grep -q '\\[solana-redeem\\] tx ' /tmp/solana-proof.plain",
};

/**
 * The gate for a change set. `changedFiles` is the branch's diff against the base, or
 * null when it could not be read, which the settlement-surface decision treats as
 * "touched" so the proof runs rather than being skipped for want of information.
 */
export function gateSteps(changedFiles: readonly string[] | null): readonly GateStep[] {
  const decision = decideSettlementSurface(changedFiles ?? [UNKNOWN_CHANGE_SET]);
  console.log(`  [gate] solana settlement surface: ${decision.reason}`);
  return decision.touched ? [...BUILD_STEPS, SOLANA_PROOF_STEP] : BUILD_STEPS;
}

/** The gate for what the branch changed against `baseBranch`. */
export async function selectSteps(
  sandbox: Sandbox,
  baseBranch: string
): Promise<readonly GateStep[]> {
  const diff = await sandbox.exec(`git diff --name-only ${baseBranch}...HEAD`);
  if (diff.exitCode !== 0) {
    console.log('  [gate] could not read the changed-file list.');
    return gateSteps(null);
  }
  return gateSteps(diff.stdout.split('\n'));
}

/**
 * Run `steps` in order, stopping at the first failure.
 *
 * Failure is returned, not thrown, so the caller can decide between a fix
 * iteration and failing the job.
 */
export async function runGate(sandbox: Sandbox, steps: readonly GateStep[]): Promise<GateResult> {
  const ran: string[] = [];

  for (const step of steps) {
    console.log(`  [gate] ${step.name}: ${step.command}`);
    const lines: string[] = [];
    const result = await sandbox.exec(step.command, {
      onLine: (line) => {
        lines.push(line);
        // Stream sparingly: full build output would bury the runner log.
        if (lines.length <= 40) console.log(`    | ${line}`);
      },
    });
    ran.push(step.name);

    if (result.exitCode !== 0) {
      const combined = [result.stdout, result.stderr].filter(Boolean).join('\n');
      const output =
        combined.length > MAX_OUTPUT_CHARS
          ? `...(truncated to the last ${MAX_OUTPUT_CHARS} chars)...\n` +
            combined.slice(-MAX_OUTPUT_CHARS)
          : combined;

      console.log(`  [gate] FAILED at ${step.name} (exit ${result.exitCode}).`);
      return {
        passed: false,
        ran,
        failure: { step: step.name, command: step.command, exitCode: result.exitCode, output },
      };
    }
  }

  console.log(`  [gate] PASSED (${ran.length} step(s): ${ran.join(', ') || 'none applicable'}).`);
  return { passed: true, ran, failure: null };
}

/** The prompt handed to a fix iteration. Concrete failure, no room to reinterpret the task. */
export function fixPrompt(failure: GateFailure, attempt: number, maxAttempts: number): string {
  return [
    `The repository gate is RED. This is fix attempt ${attempt} of ${maxAttempts}.`,
    '',
    `Failing step: ${failure.step}`,
    `Command:      ${failure.command}`,
    `Exit code:    ${failure.exitCode}`,
    '',
    'Output:',
    '```',
    failure.output,
    '```',
    '',
    'Fix the cause and commit. Rules:',
    `- Re-run \`${failure.command}\` yourself and confirm it passes before you finish.`,
    '- Fix the code. Do NOT weaken, skip, delete or skip a test, and do not',
    '  loosen a lint to make this pass — if the test is genuinely wrong, say so',
    '  explicitly in the commit message and explain why.',
    '- Change only what this failure requires. Do not refactor beyond it.',
    '- If you cannot fix it, commit nothing and explain what is blocking you.',
  ].join('\n');
}

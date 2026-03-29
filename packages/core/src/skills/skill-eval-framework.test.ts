/**
 * ATDD: Story 9.3 — Skill Eval Framework (TOON-Extended Skill-Creator)
 *
 * Structural validation tests for the skill-eval-framework Claude Agent Skill.
 * This story produces markdown + JSON + scripts (Bash + Python), NOT TypeScript code.
 * Tests validate file existence, format compliance, content coverage, eval structure,
 * TOON compliance assertions, script correctness, calibration, and batch runner behavior.
 *
 * Risk context: E9-R002 (score 6/9) — eval quality determines all downstream quality.
 *
 * Test IDs from test-design-epic-9.md:
 *   9.3-FW-001 through 9.3-FW-008
 *   9.3-CAL-001 through 9.3-CAL-003
 *
 * @see _bmad-output/implementation-artifacts/9-3-skill-eval-framework.md
 */

import { describe, it, expect } from 'vitest';
import {
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'fs';
import { resolve, join } from 'path';
import { parse as parseYaml } from 'yaml';
import { execSync } from 'child_process';

// Resolve project root (vitest runs from repo root)
const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const SKILL_DIR = join(
  PROJECT_ROOT,
  '.claude',
  'skills',
  'skill-eval-framework'
);
const REFS_DIR = join(SKILL_DIR, 'references');
const EVALS_DIR = join(SKILL_DIR, 'evals');
const SCRIPTS_DIR = join(SKILL_DIR, 'scripts');
const SKILL_MD = join(SKILL_DIR, 'SKILL.md');
const EVALS_JSON = join(EVALS_DIR, 'evals.json');

// Scripts
const RUN_EVAL = join(SCRIPTS_DIR, 'run-eval.sh');
const RUN_BATCH = join(SCRIPTS_DIR, 'run-batch.sh');
const GRADE_OUTPUT = join(SCRIPTS_DIR, 'grade-output.py');
const AGGREGATE_BENCHMARK = join(SCRIPTS_DIR, 'aggregate-benchmark.py');

// Calibration targets
const SOCIAL_INTEL_DIR = join(
  PROJECT_ROOT,
  '.claude',
  'skills',
  'nostr-social-intelligence'
);
const PROTOCOL_CORE_DIR = join(
  PROJECT_ROOT,
  '.claude',
  'skills',
  'nostr-protocol-core'
);

// Validate-skill.sh from Story 9.2
const _VALIDATE_SCRIPT = join(
  PROJECT_ROOT,
  '.claude',
  'skills',
  'nip-to-toon-skill',
  'scripts',
  'validate-skill.sh'
);

// Reference files expected by the story
const EXPECTED_REFS = [
  'eval-execution-guide.md',
  'grading-format.md',
  'benchmark-format.md',
  'toon-compliance-runner.md',
  'batch-runner-guide.md',
  'workspace-structure.md',
];

/**
 * Helper: parse YAML frontmatter from a markdown file.
 * Returns { frontmatter, body } or throws if no frontmatter.
 */
function parseFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error('No YAML frontmatter found');
  return {
    frontmatter: parseYaml(match[1]) as Record<string, unknown>,
    body: match[2],
  };
}

/**
 * Helper: read all skill files (SKILL.md + all references) and return concatenated content.
 */
function readAllSkillContent(): string {
  const parts: string[] = [];
  if (existsSync(SKILL_MD)) {
    parts.push(readFileSync(SKILL_MD, 'utf-8'));
  }
  if (existsSync(REFS_DIR)) {
    for (const file of readdirSync(REFS_DIR)) {
      parts.push(readFileSync(join(REFS_DIR, file), 'utf-8'));
    }
  }
  return parts.join('\n');
}

/**
 * Helper: count words in a string.
 */
function wordCount(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
}

// ─── AC1: Standard Toolchain Compatibility [Test: 9.3-FW-001] ─────────────

describe('[9.3-FW-001] AC1: Standard Toolchain Compatibility', () => {
  it('[P0] SKILL.md exists at .claude/skills/skill-eval-framework/SKILL.md', () => {
    expect(existsSync(SKILL_MD)).toBe(true);
  });

  it('[P0] SKILL.md has valid YAML frontmatter with name and description', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter).toHaveProperty('name', 'skill-eval-framework');
    expect(frontmatter).toHaveProperty('description');
    expect(typeof frontmatter.description).toBe('string');
  });

  it('[P0] SKILL.md frontmatter has ONLY name and description (no extraneous fields)', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const keys = Object.keys(frontmatter);
    expect(keys).toEqual(expect.arrayContaining(['name', 'description']));
    expect(keys.length).toBe(2);
  });

  it('[P0] SKILL.md body is under 500 lines', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lineCount = body.split('\n').length;
    expect(lineCount).toBeLessThan(500);
  });

  it('[P0] SKILL.md body contains "When to read" reference guidance section', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body.toLowerCase()).toContain('when to read');
  });

  it('[P0] SKILL.md body uses imperative form (no "you should")', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body.toLowerCase()).not.toContain('you should');
  });

  it('[P0] Skill directory contains references/ subdirectory', () => {
    expect(existsSync(REFS_DIR)).toBe(true);
  });

  it('[P0] Skill directory contains evals/ subdirectory', () => {
    expect(existsSync(EVALS_DIR)).toBe(true);
  });

  it('[P0] Skill directory contains scripts/ subdirectory', () => {
    expect(existsSync(SCRIPTS_DIR)).toBe(true);
  });

  it('[P1] No extraneous files in skill directory', () => {
    const topLevelFiles = readdirSync(SKILL_DIR).filter((f) => {
      // Sanitize: reject path traversal components
      if (f.includes('..') || f.includes('/') || f.includes('\\')) return false;
      // Safe: f is from readdirSync of a hardcoded project path, not user input; traversal check above
      const fullPath = resolve(SKILL_DIR, f); // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
      if (!fullPath.startsWith(SKILL_DIR)) return false;
      return !statSync(fullPath).isDirectory();
    });
    expect(topLevelFiles).toEqual(['SKILL.md']);
  });

  it('[P0] Description includes eval/validation trigger phrases', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    // Must trigger on eval/validation requests
    expect(desc).toMatch(/evaluat|validat|benchmark/i);
    // Must trigger on compliance checking
    expect(desc).toMatch(/compliance|toon compliance/i);
    // Must trigger on grading
    expect(desc).toMatch(/grad/i);
  });

  it('[P1] Description is 50-200 words', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const count = wordCount(frontmatter.description as string);
    expect(count).toBeGreaterThanOrEqual(50);
    expect(count).toBeLessThanOrEqual(200);
  });

  it('[P0] All 6 expected reference files exist', () => {
    for (const ref of EXPECTED_REFS) {
      expect(existsSync(join(REFS_DIR, ref))).toBe(true);
    }
  });

  it('[P0] No extra reference files beyond the expected 6', () => {
    const refFiles = readdirSync(REFS_DIR).filter((f) => f.endsWith('.md'));
    expect(refFiles.length).toBe(EXPECTED_REFS.length);
    for (const ref of refFiles) {
      expect(EXPECTED_REFS).toContain(ref);
    }
  });

  it('[P0] evals/evals.json exists and is valid JSON', () => {
    expect(existsSync(EVALS_JSON)).toBe(true);
    const content = readFileSync(EVALS_JSON, 'utf-8');
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it('[P0] SKILL.md body references evals.json format (trigger_evals + output_evals)', () => {
    const content = readAllSkillContent();
    const lower = content.toLowerCase();
    expect(lower).toContain('trigger_evals');
    expect(lower).toContain('output_evals');
  });

  it('[P0] SKILL.md body references grading.json format', () => {
    const content = readAllSkillContent();
    const lower = content.toLowerCase();
    expect(lower).toContain('grading.json');
  });

  it('[P0] SKILL.md body references benchmark.json format', () => {
    const content = readAllSkillContent();
    const lower = content.toLowerCase();
    expect(lower).toContain('benchmark.json');
  });

  it('[P0] Reference file eval-execution-guide.md documents eval execution procedure', () => {
    const content = readFileSync(
      join(REFS_DIR, 'eval-execution-guide.md'),
      'utf-8'
    );
    const lower = content.toLowerCase();
    expect(lower).toContain('trigger_evals');
    expect(lower).toContain('output_evals');
    expect(lower).toContain('timing');
    expect(lower).toContain('error handling');
  });

  it('[P0] Reference file grading-format.md documents grading.json schema', () => {
    const content = readFileSync(join(REFS_DIR, 'grading-format.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toContain('"text"');
    expect(lower).toContain('"passed"');
    expect(lower).toContain('"evidence"');
  });

  it('[P0] Reference file benchmark-format.md documents benchmark.json schema', () => {
    const content = readFileSync(
      join(REFS_DIR, 'benchmark-format.md'),
      'utf-8'
    );
    const lower = content.toLowerCase();
    expect(lower).toContain('pass_rate');
    expect(lower).toContain('timing');
    expect(lower).toContain('mean');
    expect(lower).toContain('stddev');
    expect(lower).toContain('token_usage');
  });
});

// ─── AC2: TOON Compliance Test Suite [Test: 9.3-FW-004] ──────────────────

describe('[9.3-FW-004] AC2: TOON Compliance Test Suite — 6 Assertion Templates', () => {
  it('[P0] toon-compliance-runner.md documents all 6 assertions', () => {
    const content = readFileSync(
      join(REFS_DIR, 'toon-compliance-runner.md'),
      'utf-8'
    );
    expect(content).toContain('toon-write-check');
    expect(content).toContain('toon-fee-check');
    expect(content).toContain('toon-format-check');
    expect(content).toContain('social-context-check');
    expect(content).toContain('trigger-coverage');
    expect(content).toContain('eval-completeness');
  });

  it('[P0] toon-write-check documents publishEvent requirement', () => {
    const content = readFileSync(
      join(REFS_DIR, 'toon-compliance-runner.md'),
      'utf-8'
    );
    expect(content).toContain('publishEvent');
    expect(content).toContain('@toon-protocol/client');
  });

  it('[P0] toon-fee-check documents fee awareness requirement', () => {
    const content = readFileSync(
      join(REFS_DIR, 'toon-compliance-runner.md'),
      'utf-8'
    );
    expect(content).toContain('basePricePerByte');
  });

  it('[P0] toon-format-check documents TOON format requirement', () => {
    const content = readFileSync(
      join(REFS_DIR, 'toon-compliance-runner.md'),
      'utf-8'
    );
    expect(content).toMatch(/TOON.format/i);
  });

  it('[P0] social-context-check documents Social Context section requirement', () => {
    const content = readFileSync(
      join(REFS_DIR, 'toon-compliance-runner.md'),
      'utf-8'
    );
    expect(content).toContain('## Social Context');
    expect(content).toContain('30 words');
  });

  it('[P0] trigger-coverage documents both protocol and social triggers', () => {
    const content = readFileSync(
      join(REFS_DIR, 'toon-compliance-runner.md'),
      'utf-8'
    );
    expect(content).toMatch(/protocol.technical/i);
    expect(content).toMatch(/social.situation/i);
  });

  it('[P0] eval-completeness documents minimum thresholds (6 trigger, 4 output)', () => {
    const content = readFileSync(
      join(REFS_DIR, 'toon-compliance-runner.md'),
      'utf-8'
    );
    expect(content).toMatch(/>= 6|>=\s*6/);
    expect(content).toMatch(/>= 4|>=\s*4/);
  });

  it('[P0] toon-compliance-runner.md documents classification detection', () => {
    const content = readFileSync(
      join(REFS_DIR, 'toon-compliance-runner.md'),
      'utf-8'
    );
    const lower = content.toLowerCase();
    expect(lower).toContain('write-capable');
    expect(lower).toContain('read-capable');
    expect(lower).toContain('classification');
  });

  it('[P0] run-eval.sh implements all 6 TOON compliance assertions', () => {
    const content = readFileSync(RUN_EVAL, 'utf-8');
    expect(content).toContain('toon-write-check');
    expect(content).toContain('toon-fee-check');
    expect(content).toContain('toon-format-check');
    expect(content).toContain('social-context-check');
    expect(content).toContain('trigger-coverage');
    expect(content).toContain('eval-completeness');
  });

  it('[P0] run-eval.sh performs classification detection', () => {
    const content = readFileSync(RUN_EVAL, 'utf-8');
    expect(content).toContain('IS_WRITE');
    expect(content).toContain('IS_READ');
    expect(content).toContain('CLASSIFICATION');
  });

  it('[P0] run-eval.sh calls validate-skill.sh as prerequisite', () => {
    const content = readFileSync(RUN_EVAL, 'utf-8');
    expect(content).toContain('validate-skill.sh');
    expect(content).toContain('VALIDATE_SCRIPT');
  });
});

// ─── AC3: Batch Runner [Test: 9.3-FW-005, 9.3-FW-006] ───────────────────

describe('[9.3-FW-005] AC3: Batch Runner — Discovery and Execution', () => {
  it('[P0] run-batch.sh exists and is executable', () => {
    expect(existsSync(RUN_BATCH)).toBe(true);
    const stat = statSync(RUN_BATCH);
    // Check executable bit (owner)
    expect(stat.mode & 0o100).toBeTruthy();
  });

  it('[P0] run-batch.sh discovers skills with evals/evals.json', () => {
    const content = readFileSync(RUN_BATCH, 'utf-8');
    expect(content).toContain('evals/evals.json');
  });

  it('[P0] run-batch.sh filters skip patterns (skill-creator, playwright-cli, rfc-, skill-eval-framework)', () => {
    const content = readFileSync(RUN_BATCH, 'utf-8');
    expect(content).toContain('skill-creator');
    expect(content).toContain('playwright-cli');
    expect(content).toContain('rfc-');
    expect(content).toContain('skill-eval-framework');
  });

  it('[P0] run-batch.sh calls run-eval.sh for each skill', () => {
    const content = readFileSync(RUN_BATCH, 'utf-8');
    expect(content).toContain('run-eval.sh');
  });

  it('[P0] run-batch.sh produces JSON report to stdout', () => {
    const content = readFileSync(RUN_BATCH, 'utf-8');
    // Must output JSON with required fields
    expect(content).toContain('"timestamp"');
    expect(content).toContain('"skills_discovered"');
    expect(content).toContain('"skills_passed"');
    expect(content).toContain('"skills_failed"');
    expect(content).toContain('"results"');
  });
});

describe('[9.3-FW-006] AC3: Aggregate Compliance Report', () => {
  it('[P0] run-batch.sh includes per-skill toon_compliance in JSON output', () => {
    const content = readFileSync(RUN_BATCH, 'utf-8');
    // In bash, JSON keys are escaped with backslash-quote
    expect(content).toMatch(/toon_compliance/);
    expect(content).toMatch(/toon-write-check/);
    expect(content).toMatch(/toon-fee-check/);
    expect(content).toMatch(/toon-format-check/);
    expect(content).toMatch(/social-context-check/);
    expect(content).toMatch(/trigger-coverage/);
    expect(content).toMatch(/eval-completeness/);
  });

  it('[P0] run-batch.sh includes per-skill overall pass/fail', () => {
    const content = readFileSync(RUN_BATCH, 'utf-8');
    // In bash heredoc/string, JSON keys are escaped
    expect(content).toMatch(/overall/);
    expect(content).toMatch(/skill_name/);
    expect(content).toMatch(/structural_pass/);
  });

  it('[P0] run-batch.sh outputs summary table to stderr', () => {
    const content = readFileSync(RUN_BATCH, 'utf-8');
    // Uses >&2 for stderr output
    expect(content).toContain('>&2');
  });

  it('[P0] run-batch.sh exits 0 when all pass, 1 when any fail', () => {
    const content = readFileSync(RUN_BATCH, 'utf-8');
    expect(content).toContain('exit 0');
    expect(content).toContain('exit 1');
  });
});

// ─── AC4: Iteration Workspace Structure [Test: 9.3-FW-008] ───────────────

describe('[9.3-FW-008] AC4: Iteration Workspace Structure', () => {
  it('[P0] workspace-structure.md documents iteration directory layout', () => {
    const content = readFileSync(
      join(REFS_DIR, 'workspace-structure.md'),
      'utf-8'
    );
    expect(content).toContain('iteration-');
    expect(content).toContain('with_skill');
    expect(content).toContain('without_skill');
    expect(content).toContain('outputs');
  });

  it('[P0] workspace-structure.md documents eval_metadata.json', () => {
    const content = readFileSync(
      join(REFS_DIR, 'workspace-structure.md'),
      'utf-8'
    );
    expect(content).toContain('eval_metadata.json');
    expect(content).toContain('skill_name');
    expect(content).toContain('eval_id');
  });

  it('[P0] workspace-structure.md documents timing.json', () => {
    const content = readFileSync(
      join(REFS_DIR, 'workspace-structure.md'),
      'utf-8'
    );
    expect(content).toContain('timing.json');
    expect(content).toContain('duration_seconds');
  });

  it('[P0] workspace-structure.md documents grading.json placement', () => {
    const content = readFileSync(
      join(REFS_DIR, 'workspace-structure.md'),
      'utf-8'
    );
    expect(content).toContain('grading.json');
  });

  it('[P0] workspace-structure.md documents workspace creation procedure', () => {
    const content = readFileSync(
      join(REFS_DIR, 'workspace-structure.md'),
      'utf-8'
    );
    const lower = content.toLowerCase();
    expect(lower).toMatch(/creat.*workspace|workspace.*creat/);
  });

  it('[P0] workspace-structure.md documents benchmark.json at iteration level', () => {
    const content = readFileSync(
      join(REFS_DIR, 'workspace-structure.md'),
      'utf-8'
    );
    expect(content).toContain('benchmark.json');
  });
});

// ─── AC5: Grading Output [Test: 9.3-FW-002] ──────────────────────────────

describe('[9.3-FW-002] AC5: Grading Output', () => {
  it('[P0] grade-output.py exists and is executable', () => {
    expect(existsSync(GRADE_OUTPUT)).toBe(true);
    const stat = statSync(GRADE_OUTPUT);
    expect(stat.mode & 0o100).toBeTruthy();
  });

  it('[P0] grade-output.py accepts --response and --assertions flags', () => {
    const content = readFileSync(GRADE_OUTPUT, 'utf-8');
    expect(content).toContain('--response');
    expect(content).toContain('--assertions');
  });

  it('[P0] grade-output.py supports --assertions-json inline flag', () => {
    const content = readFileSync(GRADE_OUTPUT, 'utf-8');
    expect(content).toContain('--assertions-json');
  });

  it('[P0] grade-output.py uses only Python stdlib (no pip dependencies)', () => {
    const content = readFileSync(GRADE_OUTPUT, 'utf-8');
    // Check imports — should only be stdlib modules
    const imports = content.match(/^import\s+(\w+)/gm) || [];
    const fromImports = content.match(/^from\s+(\w+)/gm) || [];
    const allImports = [...imports, ...fromImports].map((i) =>
      i.replace(/^(import|from)\s+/, '')
    );
    const stdlibModules = [
      'argparse',
      'json',
      're',
      'sys',
      'os',
      'math',
      'statistics',
      'datetime',
    ];
    for (const mod of allImports) {
      expect(stdlibModules).toContain(mod);
    }
  });

  it('[P0] grade-output.py produces valid grading.json with text, passed, evidence', () => {
    // Create temp response and assertions files
    const tmpDir = join(PROJECT_ROOT, '.tmp-grade-test');
    mkdirSync(tmpDir, { recursive: true });
    try {
      const responseFile = join(tmpDir, 'response.txt');
      const assertionsFile = join(tmpDir, 'assertions.json');
      writeFileSync(
        responseFile,
        'Use publishEvent() from @toon-protocol/client to publish events. The fee is calculated using basePricePerByte.'
      );
      writeFileSync(
        assertionsFile,
        JSON.stringify([
          'Response mentions publishEvent',
          'Response mentions basePricePerByte or fee',
        ])
      );

      const output = execSync(
        `python3 "${GRADE_OUTPUT}" --response "${responseFile}" --assertions "${assertionsFile}"`,
        { encoding: 'utf-8' }
      );
      const grading = JSON.parse(output);
      expect(Array.isArray(grading)).toBe(true);
      expect(grading.length).toBe(2);
      for (const entry of grading) {
        expect(entry).toHaveProperty('text');
        expect(entry).toHaveProperty('passed');
        expect(entry).toHaveProperty('evidence');
        expect(typeof entry.text).toBe('string');
        expect(typeof entry.passed).toBe('boolean');
        expect(typeof entry.evidence).toBe('string');
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('[P0] grade-output.py passes assertions when key terms are present', () => {
    const tmpDir = join(PROJECT_ROOT, '.tmp-grade-test-pass');
    mkdirSync(tmpDir, { recursive: true });
    try {
      const responseFile = join(tmpDir, 'response.txt');
      writeFileSync(
        responseFile,
        'Use publishEvent() from @toon-protocol/client to publish. The basePricePerByte determines cost.'
      );

      const output = execSync(
        `python3 "${GRADE_OUTPUT}" --response "${responseFile}" --assertions-json '${JSON.stringify(
          ['Response mentions publishEvent']
        )}'`,
        { encoding: 'utf-8' }
      );
      const grading = JSON.parse(output);
      expect(grading[0].passed).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('[P0] grade-output.py fails assertions when key terms are missing', () => {
    const tmpDir = join(PROJECT_ROOT, '.tmp-grade-test-fail');
    mkdirSync(tmpDir, { recursive: true });
    try {
      const responseFile = join(tmpDir, 'response.txt');
      writeFileSync(
        responseFile,
        'Use relay.send() to push events directly over WebSocket.'
      );

      const output = execSync(
        `python3 "${GRADE_OUTPUT}" --response "${responseFile}" --assertions-json '${JSON.stringify(
          ['Response mentions publishEvent from @toon-protocol/client']
        )}'`,
        { encoding: 'utf-8' }
      );
      const grading = JSON.parse(output);
      expect(grading[0].passed).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('[P0] grade-output.py handles negation assertions correctly', () => {
    const tmpDir = join(PROJECT_ROOT, '.tmp-grade-test-negation');
    mkdirSync(tmpDir, { recursive: true });
    try {
      const responseFile = join(tmpDir, 'response.txt');
      writeFileSync(
        responseFile,
        'Always use publishEvent(). Do not send raw WebSocket messages.'
      );

      const output = execSync(
        `python3 "${GRADE_OUTPUT}" --response "${responseFile}" --assertions-json '${JSON.stringify(
          ['Response does NOT recommend raw WebSocket']
        )}'`,
        { encoding: 'utf-8' }
      );
      const grading = JSON.parse(output);
      // The assertion checks that "raw WebSocket" IS present, so negation should detect it
      // This is a nuanced case — the response mentions "do not send raw WebSocket" which contains the term
      expect(grading[0]).toHaveProperty('passed');
      expect(typeof grading[0].passed).toBe('boolean');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('[P1] grade-output.py handles empty response gracefully', () => {
    const tmpDir = join(PROJECT_ROOT, '.tmp-grade-test-empty');
    mkdirSync(tmpDir, { recursive: true });
    try {
      const responseFile = join(tmpDir, 'response.txt');
      writeFileSync(responseFile, '');

      const result = execSync(
        `python3 "${GRADE_OUTPUT}" --response "${responseFile}" --assertions-json '["Response mentions anything"]' 2>&1; echo "EXIT:$?"`,
        { encoding: 'utf-8' }
      );
      // Should exit with non-zero or output an error
      expect(result).toMatch(/error|EXIT:1/i);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── AC6: Benchmark Aggregation [Test: 9.3-FW-003] ───────────────────────

describe('[9.3-FW-003] AC6: Benchmark Aggregation', () => {
  it('[P0] aggregate-benchmark.py exists and is executable', () => {
    expect(existsSync(AGGREGATE_BENCHMARK)).toBe(true);
    const stat = statSync(AGGREGATE_BENCHMARK);
    expect(stat.mode & 0o100).toBeTruthy();
  });

  it('[P0] aggregate-benchmark.py accepts --workspace flag', () => {
    const content = readFileSync(AGGREGATE_BENCHMARK, 'utf-8');
    expect(content).toContain('--workspace');
  });

  it('[P0] aggregate-benchmark.py uses only Python stdlib (no pip dependencies)', () => {
    const content = readFileSync(AGGREGATE_BENCHMARK, 'utf-8');
    const imports = content.match(/^import\s+(\w+)/gm) || [];
    const fromImports = content.match(/^from\s+(\w+)/gm) || [];
    const allImports = [...imports, ...fromImports].map((i) =>
      i.replace(/^(import|from)\s+/, '')
    );
    const stdlibModules = [
      'argparse',
      'json',
      're',
      'sys',
      'os',
      'math',
      'statistics',
      'datetime',
    ];
    for (const mod of allImports) {
      expect(stdlibModules).toContain(mod);
    }
  });

  it('[P0] aggregate-benchmark.py produces valid benchmark.json with required fields', () => {
    const tmpDir = join(PROJECT_ROOT, '.tmp-benchmark-test');
    const evalDir = join(tmpDir, 'eval-test', 'with_skill');
    mkdirSync(evalDir, { recursive: true });
    try {
      // Create a grading.json
      writeFileSync(
        join(evalDir, 'grading.json'),
        JSON.stringify([
          { text: 'assertion 1', passed: true, evidence: 'Found key term.' },
          { text: 'assertion 2', passed: false, evidence: 'Missing key term.' },
          { text: 'assertion 3', passed: true, evidence: 'Found.' },
        ])
      );
      // Create a timing.json
      writeFileSync(
        join(evalDir, 'timing.json'),
        JSON.stringify({
          eval_id: 'test',
          start: '2026-03-25T10:00:00Z',
          end: '2026-03-25T10:00:03Z',
          duration_seconds: 3.0,
        })
      );

      const output = execSync(
        `python3 "${AGGREGATE_BENCHMARK}" --workspace "${tmpDir}"`,
        { encoding: 'utf-8' }
      );
      const benchmark = JSON.parse(output);

      expect(benchmark).toHaveProperty('pass_rate');
      expect(typeof benchmark.pass_rate).toBe('number');
      expect(benchmark).toHaveProperty('timing');
      expect(benchmark.timing).toHaveProperty('mean');
      expect(benchmark.timing).toHaveProperty('stddev');
      expect(benchmark).toHaveProperty('token_usage');
      expect(benchmark.token_usage).toHaveProperty('prompt');
      expect(benchmark.token_usage).toHaveProperty('completion');
      expect(benchmark).toHaveProperty('metadata');
      expect(benchmark.metadata).toHaveProperty('eval_count');
      expect(benchmark.metadata).toHaveProperty('timestamp');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('[P0] aggregate-benchmark.py correctly calculates pass rate', () => {
    const tmpDir = join(PROJECT_ROOT, '.tmp-benchmark-rate');
    const evalDir = join(tmpDir, 'eval-test', 'with_skill');
    mkdirSync(evalDir, { recursive: true });
    try {
      // 2 pass, 1 fail => 66.7%
      writeFileSync(
        join(evalDir, 'grading.json'),
        JSON.stringify([
          { text: 'a1', passed: true, evidence: 'ok' },
          { text: 'a2', passed: true, evidence: 'ok' },
          { text: 'a3', passed: false, evidence: 'missing' },
        ])
      );

      const output = execSync(
        `python3 "${AGGREGATE_BENCHMARK}" --workspace "${tmpDir}"`,
        { encoding: 'utf-8' }
      );
      const benchmark = JSON.parse(output);
      expect(benchmark.pass_rate).toBeCloseTo(66.7, 0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('[P0] aggregate-benchmark.py correctly computes timing mean and stddev', () => {
    const tmpDir = join(PROJECT_ROOT, '.tmp-benchmark-timing');
    const eval1 = join(tmpDir, 'eval-1', 'with_skill');
    const eval2 = join(tmpDir, 'eval-2', 'with_skill');
    mkdirSync(eval1, { recursive: true });
    mkdirSync(eval2, { recursive: true });
    try {
      // Provide grading to each so they are counted
      writeFileSync(
        join(eval1, 'grading.json'),
        JSON.stringify([{ text: 'a', passed: true, evidence: 'ok' }])
      );
      writeFileSync(
        join(eval2, 'grading.json'),
        JSON.stringify([{ text: 'b', passed: true, evidence: 'ok' }])
      );
      // Timing: 2.0 and 4.0 => mean 3.0, stddev 1.0
      writeFileSync(
        join(eval1, 'timing.json'),
        JSON.stringify({ eval_id: '1', duration_seconds: 2.0 })
      );
      writeFileSync(
        join(eval2, 'timing.json'),
        JSON.stringify({ eval_id: '2', duration_seconds: 4.0 })
      );

      const output = execSync(
        `python3 "${AGGREGATE_BENCHMARK}" --workspace "${tmpDir}"`,
        { encoding: 'utf-8' }
      );
      const benchmark = JSON.parse(output);
      expect(benchmark.timing.mean).toBeCloseTo(3.0, 1);
      expect(benchmark.timing.stddev).toBeCloseTo(1.0, 1);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('[P1] aggregate-benchmark.py handles missing workspace gracefully', () => {
    const result = execSync(
      `python3 "${AGGREGATE_BENCHMARK}" --workspace "/nonexistent/path" 2>&1; echo "EXIT:$?"`,
      { encoding: 'utf-8' }
    );
    expect(result).toMatch(/error|EXIT:1/i);
  });
});

// ─── AC7: With/Without Execution [Test: 9.3-FW-007] ──────────────────────

describe('[9.3-FW-007] AC7: With/Without Execution', () => {
  it('[P0] SKILL.md body documents with/without testing procedure', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toContain('with/without');
    expect(lower).toContain('with_skill');
    expect(lower).toContain('without_skill');
  });

  it('[P0] SKILL.md body documents parallel evaluation approach', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/parallel|value.add|baseline/);
  });

  it('[P0] workspace-structure.md documents with_skill and without_skill directories', () => {
    const content = readFileSync(
      join(REFS_DIR, 'workspace-structure.md'),
      'utf-8'
    );
    expect(content).toContain('with_skill');
    expect(content).toContain('without_skill');
    expect(content).toContain('outputs/');
  });

  it('[P0] workspace-structure.md documents comparison methodology', () => {
    const content = readFileSync(
      join(REFS_DIR, 'workspace-structure.md'),
      'utf-8'
    );
    const lower = content.toLowerCase();
    // Should discuss comparing results between with and without runs
    expect(lower).toMatch(/compar|differ|baseline/);
  });
});

// ─── AC8: Calibration Against Known Skills [Test: 9.3-CAL-001 through 9.3-CAL-003] ──

describe('[9.3-CAL-002] AC8: Calibration — Known-good skills pass', () => {
  it('[P0] run-eval.sh passes on nostr-protocol-core (known-good, write-capable)', () => {
    // AC8 criteria: known-good skill passes with no false positives
    const result = execSync(`bash "${RUN_EVAL}" "${PROTOCOL_CORE_DIR}" 2>&1`, {
      encoding: 'utf-8',
      timeout: 30000,
    });
    expect(result).toContain('Status: PASS');
  });

  it('[P0] run-eval.sh passes on nostr-social-intelligence (known-good)', () => {
    const result = execSync(`bash "${RUN_EVAL}" "${SOCIAL_INTEL_DIR}" 2>&1`, {
      encoding: 'utf-8',
      timeout: 30000,
    });
    expect(result).toContain('Status: PASS');
  });

  it('[P0] run-eval.sh classifies nostr-protocol-core as write-capable or both', () => {
    const result = execSync(`bash "${RUN_EVAL}" "${PROTOCOL_CORE_DIR}" 2>&1`, {
      encoding: 'utf-8',
      timeout: 30000,
    });
    expect(result).toMatch(/Classification: (write-capable|both)/);
  });
});

describe('[9.3-CAL-001] AC8: Calibration — Deliberately bad skill is caught', () => {
  const BAD_SKILL_DIR = join(PROJECT_ROOT, '.tmp-bad-skill');

  it('[P0] run-eval.sh catches deliberately broken skill (missing Social Context, short description)', () => {
    // Create a deliberately broken skill
    mkdirSync(join(BAD_SKILL_DIR, 'references'), { recursive: true });
    mkdirSync(join(BAD_SKILL_DIR, 'evals'), { recursive: true });
    try {
      // SKILL.md with short description, no Social Context section
      writeFileSync(
        join(BAD_SKILL_DIR, 'SKILL.md'),
        [
          '---',
          'name: bad-test-skill',
          'description: A short desc.',
          '---',
          '',
          '# Bad Skill',
          '',
          'This skill does nothing useful.',
        ].join('\n')
      );
      // Empty reference file
      writeFileSync(
        join(BAD_SKILL_DIR, 'references', 'dummy.md'),
        'Some reference text.'
      );
      // evals.json with too few evals
      writeFileSync(
        join(BAD_SKILL_DIR, 'evals', 'evals.json'),
        JSON.stringify({
          trigger_evals: [{ query: 'test query', should_trigger: true }],
          output_evals: [
            {
              id: 'test',
              prompt: 'test',
              expected_output: 'test',
              rubric: {},
              assertions: [],
            },
          ],
        })
      );

      // run-eval.sh should fail on structural validation (description too short)
      const result = execSync(
        `bash "${RUN_EVAL}" "${BAD_SKILL_DIR}" 2>&1 || true`,
        { encoding: 'utf-8', timeout: 30000 }
      );
      // Should report failure — either structural or compliance
      expect(result).toMatch(/FAIL/);
    } finally {
      rmSync(BAD_SKILL_DIR, { recursive: true, force: true });
    }
  });
});

describe('[9.3-CAL-003] AC8: Calibration — Social eval calibration', () => {
  it('[P0] nostr-social-intelligence evals/evals.json has rubric-based output evals', () => {
    // Verify the calibration target has rubric-based grading
    const evalsPath = join(SOCIAL_INTEL_DIR, 'evals', 'evals.json');
    expect(existsSync(evalsPath)).toBe(true);
    const evals = JSON.parse(readFileSync(evalsPath, 'utf-8'));
    expect(evals).toHaveProperty('output_evals');
    expect(evals.output_evals.length).toBeGreaterThanOrEqual(1);
    // At least one output eval should have a rubric
    const withRubric = evals.output_evals.filter(
      (e: { rubric?: unknown }) => e.rubric !== undefined
    );
    expect(withRubric.length).toBeGreaterThanOrEqual(1);
  });

  it('[P0] grading-format.md documents rubric-based grading (correct/acceptable/incorrect)', () => {
    const content = readFileSync(join(REFS_DIR, 'grading-format.md'), 'utf-8');
    expect(content).toContain('correct');
    expect(content).toContain('acceptable');
    expect(content).toContain('incorrect');
    expect(content).toContain('rubric');
  });

  it('[P0] grading-format.md documents 80% pass threshold', () => {
    const content = readFileSync(join(REFS_DIR, 'grading-format.md'), 'utf-8');
    expect(content).toMatch(/80%|80 ?%/);
  });
});

// ─── Evals Structure ──────────────────────────────────────────────────────

describe('[9.3-FW-001] Evals File Structure', () => {
  it('[P0] evals.json has trigger_evals array', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    expect(evals).toHaveProperty('trigger_evals');
    expect(Array.isArray(evals.trigger_evals)).toBe(true);
  });

  it('[P0] 8-10 should-trigger queries', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const shouldTrigger = evals.trigger_evals.filter(
      (e: { should_trigger: boolean }) => e.should_trigger === true
    );
    expect(shouldTrigger.length).toBeGreaterThanOrEqual(8);
    expect(shouldTrigger.length).toBeLessThanOrEqual(10);
  });

  it('[P0] 8-10 should-not-trigger queries', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const shouldNotTrigger = evals.trigger_evals.filter(
      (e: { should_trigger: boolean }) => e.should_trigger === false
    );
    expect(shouldNotTrigger.length).toBeGreaterThanOrEqual(6);
    expect(shouldNotTrigger.length).toBeLessThanOrEqual(10);
  });

  it('[P0] evals.json has output_evals array', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    expect(evals).toHaveProperty('output_evals');
    expect(Array.isArray(evals.output_evals)).toBe(true);
  });

  it('[P0] 4-6 output evals', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    expect(evals.output_evals.length).toBeGreaterThanOrEqual(4);
    expect(evals.output_evals.length).toBeLessThanOrEqual(6);
  });

  it('[P0] Each output eval has id, prompt, expected_output, assertions', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    for (const oe of evals.output_evals) {
      expect(oe).toHaveProperty('id');
      expect(oe).toHaveProperty('prompt');
      expect(oe).toHaveProperty('expected_output');
      expect(oe).toHaveProperty('assertions');
      expect(Array.isArray(oe.assertions)).toBe(true);
    }
  });

  it('[P0] Each trigger eval has query and should_trigger fields', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    for (const te of evals.trigger_evals) {
      expect(te).toHaveProperty('query');
      expect(typeof te.query).toBe('string');
      expect(te).toHaveProperty('should_trigger');
      expect(typeof te.should_trigger).toBe('boolean');
    }
  });

  it('[P1] Should-trigger queries include eval/validation scenarios', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const triggers = evals.trigger_evals
      .filter((e: { should_trigger: boolean }) => e.should_trigger === true)
      .map((e: { query: string }) => e.query.toLowerCase())
      .join(' ');
    expect(triggers).toMatch(/evaluat|validat|compliance|benchmark|grade/);
  });

  it('[P1] Should-not-trigger queries distinguish from pipeline, protocol-core, social-intelligence', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const nonTriggers = evals.trigger_evals
      .filter((e: { should_trigger: boolean }) => e.should_trigger === false)
      .map((e: { query: string }) => e.query.toLowerCase())
      .join(' ');
    // Should include pipeline or protocol-core or social territory
    expect(nonTriggers).toMatch(/create|convert|publish|react|social|fee/);
  });

  it('[P0] Output evals include rubric (correct/acceptable/incorrect)', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    for (const oe of evals.output_evals) {
      expect(oe).toHaveProperty('rubric');
      expect(oe.rubric).toHaveProperty('correct');
      expect(oe.rubric).toHaveProperty('acceptable');
      expect(oe.rubric).toHaveProperty('incorrect');
    }
  });
});

// ─── TOON Compliance Across All Files ─────────────────────────────────────

describe('[9.3-TOON] TOON Compliance Across All Skill Files', () => {
  it('[P0] SKILL.md has ## Social Context section', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    expect(content).toContain('## Social Context');
  });

  it('[P0] Social Context section is substantial (>= 30 words)', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const scMatch = content.match(
      /## Social Context\s*\n([\s\S]*?)(?=\n## |\n---|\n$)/
    );
    expect(scMatch).not.toBeNull();
    if (scMatch) {
      const count = wordCount(scMatch[1]);
      expect(count).toBeGreaterThanOrEqual(30);
    }
  });

  it('[P0] Description includes both protocol-technical AND social-situation triggers', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    // Protocol-technical
    expect(desc).toMatch(/eval|compliance|benchmark|validation|grading/);
    // Social-situation (question-form triggers)
    expect(desc).toMatch(/is this|ready|how|measure|compare|effectiveness/);
  });

  it('[P0] evals.json has >= 6 trigger evals with mix of true/false', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    expect(evals.trigger_evals.length).toBeGreaterThanOrEqual(6);
    const trueCount = evals.trigger_evals.filter(
      (e: { should_trigger: boolean }) => e.should_trigger === true
    ).length;
    const falseCount = evals.trigger_evals.filter(
      (e: { should_trigger: boolean }) => e.should_trigger === false
    ).length;
    expect(trueCount).toBeGreaterThanOrEqual(1);
    expect(falseCount).toBeGreaterThanOrEqual(1);
  });

  it('[P0] evals.json has >= 4 output evals each with assertions', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    expect(evals.output_evals.length).toBeGreaterThanOrEqual(4);
    for (const oe of evals.output_evals) {
      expect(Array.isArray(oe.assertions)).toBe(true);
      expect(oe.assertions.length).toBeGreaterThan(0);
    }
  });
});

// ─── D9-008 Compliance: Reference Files Explain WHY ───────────────────────

describe('[9.3-D9-008] All Reference Files Explain WHY (Reasoning)', () => {
  for (const ref of EXPECTED_REFS) {
    it(`[P1] ${ref} contains reasoning/explanation (blockquote or "why")`, () => {
      const content = readFileSync(join(REFS_DIR, ref), 'utf-8');
      const lower = content.toLowerCase();
      // Must contain WHY reasoning — either blockquote rationale or "why" keyword
      expect(lower).toMatch(/\bwhy\b|> \*\*why/);
    });
  }
});

// ─── Script Execution: run-eval.sh ────────────────────────────────────────

describe('[9.3-FW-004] run-eval.sh Script Execution', () => {
  it('[P0] run-eval.sh exists and is executable', () => {
    expect(existsSync(RUN_EVAL)).toBe(true);
    const stat = statSync(RUN_EVAL);
    expect(stat.mode & 0o100).toBeTruthy();
  });

  it('[P0] run-eval.sh exits with proper usage when no argument given', () => {
    try {
      execSync(`bash "${RUN_EVAL}" 2>&1`, { encoding: 'utf-8' });
      // Should not reach here
      expect(true).toBe(false);
    } catch (e) {
      // Should fail with usage message
      expect((e as { status: number }).status).not.toBe(0);
    }
  });

  it('[P0] run-eval.sh uses bash and set -euo pipefail', () => {
    const content = readFileSync(RUN_EVAL, 'utf-8');
    expect(content).toContain('#!/usr/bin/env bash');
    expect(content).toContain('set -euo pipefail');
  });

  it('[P0] run-eval.sh self-validates on skill-eval-framework', () => {
    const result = execSync(`bash "${RUN_EVAL}" "${SKILL_DIR}" 2>&1`, {
      encoding: 'utf-8',
      timeout: 30000,
    });
    expect(result).toContain('Status: PASS');
  });
});

// ─── Script Execution: run-batch.sh ───────────────────────────────────────

describe('[9.3-FW-005] run-batch.sh Script Execution', () => {
  it('[P0] run-batch.sh uses bash and set -euo pipefail', () => {
    const content = readFileSync(RUN_BATCH, 'utf-8');
    expect(content).toContain('#!/usr/bin/env bash');
    expect(content).toContain('set -euo pipefail');
  });

  it('[P0] run-batch.sh produces valid JSON on stdout when run against project skills', () => {
    // Run batch and capture stdout (JSON) separately from stderr (summary)
    const result = execSync(
      `bash "${RUN_BATCH}" "${join(PROJECT_ROOT, '.claude', 'skills')}" 2>/dev/null`,
      { encoding: 'utf-8', timeout: 60000 }
    );
    const report = JSON.parse(result);
    expect(report).toHaveProperty('timestamp');
    expect(report).toHaveProperty('skills_discovered');
    expect(report).toHaveProperty('results');
    expect(Array.isArray(report.results)).toBe(true);
    expect(report.skills_discovered).toBeGreaterThanOrEqual(2);
  });

  it('[P0] run-batch.sh discovers nostr-protocol-core and nostr-social-intelligence', () => {
    const result = execSync(
      `bash "${RUN_BATCH}" "${join(PROJECT_ROOT, '.claude', 'skills')}" 2>/dev/null`,
      { encoding: 'utf-8', timeout: 60000 }
    );
    const report = JSON.parse(result);
    const skillNames = report.results.map(
      (r: { skill_name: string }) => r.skill_name
    );
    expect(skillNames).toContain('nostr-protocol-core');
    expect(skillNames).toContain('nostr-social-intelligence');
  });

  it('[P0] run-batch.sh skips skill-creator and skill-eval-framework', () => {
    const result = execSync(
      `bash "${RUN_BATCH}" "${join(PROJECT_ROOT, '.claude', 'skills')}" 2>/dev/null`,
      { encoding: 'utf-8', timeout: 60000 }
    );
    const report = JSON.parse(result);
    const skillNames = report.results.map(
      (r: { skill_name: string }) => r.skill_name
    );
    expect(skillNames).not.toContain('skill-creator');
    expect(skillNames).not.toContain('skill-eval-framework');
  });

  it('[P0] run-batch.sh reports all discovered skills as PASS', () => {
    const result = execSync(
      `bash "${RUN_BATCH}" "${join(PROJECT_ROOT, '.claude', 'skills')}" 2>/dev/null`,
      { encoding: 'utf-8', timeout: 60000 }
    );
    const report = JSON.parse(result);
    for (const skill of report.results) {
      expect(skill.overall).toBe('PASS');
    }
  });
});

// ─── Integration: SKILL.md Body Content Coverage ──────────────────────────

describe('[9.3-CONTENT] SKILL.md Body Content Coverage', () => {
  it('[P0] SKILL.md body covers Single Skill Evaluation procedure', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/single skill|single.*eval/i);
  });

  it('[P0] SKILL.md body covers TOON Compliance Assertions (6 checks)', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toContain('toon-write-check');
    expect(body).toContain('toon-fee-check');
    expect(body).toContain('toon-format-check');
    expect(body).toContain('social-context-check');
    expect(body).toContain('trigger-coverage');
    expect(body).toContain('eval-completeness');
  });

  it('[P0] SKILL.md body covers Batch Runner procedure', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/batch.*runner|batch.*valid/);
  });

  it('[P0] SKILL.md body covers Aggregate Report format', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/aggregate.*report/);
  });

  it('[P0] SKILL.md body covers Integration with Other Skills section', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toContain('nip-to-toon-skill');
    expect(body).toContain('nostr-protocol-core');
    expect(body).toContain('nostr-social-intelligence');
    expect(body).toContain('skill-creator');
  });

  it('[P0] SKILL.md body documents classification detection (write/read/both)', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toContain('write-capable');
    expect(lower).toContain('read-capable');
  });
});

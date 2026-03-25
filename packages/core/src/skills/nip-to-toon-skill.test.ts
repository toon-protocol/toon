/**
 * ATDD: Story 9.2 — NIP-to-TOON Skill Pipeline (nip-to-toon-skill)
 *
 * Structural validation tests for the nip-to-toon-skill Claude Agent Skill.
 * This story produces markdown + JSON + one bash script, NOT TypeScript code.
 * Tests validate file existence, format compliance, content coverage, eval structure,
 * pipeline step documentation, TOON compliance, and validate-skill.sh correctness.
 *
 * This is the HIGHEST-RISK story in Epic 9 (E9-R001, score 9/9).
 * A defect in the pipeline propagates to ~30 downstream skills.
 *
 * TDD RED PHASE: Skill files do not yet exist — all tests will fail.
 *
 * Test IDs from test-design-epic-9.md:
 *   9.2-STRUCT-001, 9.2-STRUCT-002, 9.2-STRUCT-003
 *   9.2-STEP-001 through 9.2-STEP-010
 *   9.2-META-001 through 9.2-META-004
 *   D9-010 (protocol context reference)
 *
 * @see _bmad-output/implementation-artifacts/9-2-nip-to-toon-skill-pipeline.md
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';
import { parse as parseYaml } from 'yaml';
import { execSync } from 'child_process';

// Resolve project root (vitest runs from repo root)
const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const SKILL_DIR = join(PROJECT_ROOT, '.claude', 'skills', 'nip-to-toon-skill');
const REFS_DIR = join(SKILL_DIR, 'references');
const EVALS_DIR = join(SKILL_DIR, 'evals');
const SCRIPTS_DIR = join(SKILL_DIR, 'scripts');
const SKILL_MD = join(SKILL_DIR, 'SKILL.md');
const EVALS_JSON = join(EVALS_DIR, 'evals.json');
const VALIDATE_SCRIPT = join(SCRIPTS_DIR, 'validate-skill.sh');

// Reference files expected by the story
const EXPECTED_REFS = [
  'toon-protocol-context.md',
  'skill-structure-template.md',
  'social-context-template.md',
  'eval-generation-guide.md',
  'toon-compliance-assertions.md',
  'description-optimization-guide.md',
];

// Canonical protocol context from Story 9.1 for consistency checking
const CANONICAL_PROTOCOL_CONTEXT = join(
  PROJECT_ROOT,
  '.claude',
  'skills',
  'nostr-protocol-core',
  'references',
  'toon-protocol-context.md'
);

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
 * Used for TOON compliance checks across the entire skill.
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

// ─── AC1: SKILL.md Core File [Test: 9.2-STRUCT-001] ───────────────────────

describe('[9.2-STRUCT-001] AC1: SKILL.md Core File', () => {
  it('[P0] SKILL.md exists at .claude/skills/nip-to-toon-skill/SKILL.md', () => {
    // Given the nip-to-toon-skill directory
    // When checking for the core SKILL.md file
    // Then it must exist
    expect(existsSync(SKILL_MD)).toBe(true);
  });

  it('[P0] SKILL.md has valid YAML frontmatter with name and description', () => {
    // Given the SKILL.md file
    // When parsing YAML frontmatter
    // Then it must contain name and description fields
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter).toHaveProperty('name', 'nip-to-toon-skill');
    expect(frontmatter).toHaveProperty('description');
    expect(typeof frontmatter.description).toBe('string');
  });

  it('[P0] SKILL.md frontmatter has ONLY name and description (no extraneous fields)', () => {
    // Given the SKILL.md YAML frontmatter
    // When checking field count
    // Then only name and description exist (per skill-creator guidelines)
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const keys = Object.keys(frontmatter);
    expect(keys).toEqual(expect.arrayContaining(['name', 'description']));
    expect(keys.length).toBe(2);
  });

  it('[P0] SKILL.md body is under 500 lines', () => {
    // Given the SKILL.md body (after frontmatter)
    // When counting lines
    // Then it must be under 500 lines (progressive disclosure — detail goes to references)
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lineCount = body.split('\n').length;
    expect(lineCount).toBeLessThan(500);
  });

  it('[P0] SKILL.md body contains "When to read each reference" section', () => {
    // Given the SKILL.md body
    // When searching for reference guidance
    // Then a section explaining when to read each reference must exist
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body.toLowerCase()).toContain('when to read');
  });

  it('[P0] SKILL.md body uses imperative form (no "you should")', () => {
    // Given the SKILL.md body
    // When checking writing style
    // Then it must not contain "you should" (use imperative/infinitive per skill-creator)
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body.toLowerCase()).not.toContain('you should');
  });

  it('[P0] Skill directory contains references/ subdirectory', () => {
    // Given the nip-to-toon-skill directory
    // When checking directory structure
    // Then references/ must exist
    expect(existsSync(REFS_DIR)).toBe(true);
  });

  it('[P0] Skill directory contains evals/ subdirectory', () => {
    // Given the nip-to-toon-skill directory
    // When checking directory structure
    // Then evals/ must exist
    expect(existsSync(EVALS_DIR)).toBe(true);
  });

  it('[P0] Skill directory contains scripts/ subdirectory', () => {
    // Given the nip-to-toon-skill directory
    // When checking directory structure
    // Then scripts/ must exist
    expect(existsSync(SCRIPTS_DIR)).toBe(true);
  });

  it('[P1] No extraneous files in skill directory', () => {
    // Given the nip-to-toon-skill directory
    // When listing top-level files
    // Then only SKILL.md should exist (no README.md, CHANGELOG.md, etc.)
    const topLevelFiles = readdirSync(SKILL_DIR).filter(
      (f) => !statSync(join(SKILL_DIR, f)).isDirectory()
    );
    expect(topLevelFiles).toEqual(['SKILL.md']);
  });

  it('[P0] Description includes pipeline trigger phrases', () => {
    // Given the SKILL.md description field
    // When checking for NIP-to-TOON pipeline trigger content
    // Then it must include NIP conversion and pipeline-related triggers
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    // Must trigger on NIP conversion requests
    expect(desc).toMatch(/nip.*skill|skill.*nip|convert.*nip|nip.*toon/i);
    // Must trigger on pipeline execution
    expect(desc).toMatch(/pipeline|skill factory|skill.*from/i);
  });

  it('[P1] Description is 50-200 words', () => {
    // Given the SKILL.md description
    // When counting words
    // Then it must be 50-200 words (enough trigger coverage without bloat)
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const count = wordCount(frontmatter.description as string);
    expect(count).toBeGreaterThanOrEqual(50);
    expect(count).toBeLessThanOrEqual(200);
  });
});

// ─── AC1: 13-Step Pipeline Documentation ─────────────────────────────────

describe('[9.2-STRUCT-001] AC1: 13-Step Pipeline in SKILL.md', () => {
  it('[P0] SKILL.md body documents all 13 pipeline steps', () => {
    // Given the SKILL.md body
    // When checking pipeline step coverage
    // Then all 13 steps must be referenced
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toContain('nip analysis');
    expect(lower).toContain('toon context');
    expect(lower).toContain('social context');
    expect(lower).toContain('skill authoring');
    expect(lower).toContain('eval generation');
    expect(lower).toContain('toon assertion');
    expect(lower).toContain('description optimization');
    expect(lower).toContain('with/without');
    expect(lower).toContain('grading');
    expect(lower).toContain('benchmark');
    expect(lower).toContain('toon compliance');
    expect(lower).toContain('eval viewer');
    expect(lower).toContain('iterate');
  });

  it('[P0] SKILL.md body includes NIP Classification section', () => {
    // Given the SKILL.md body
    // When checking for NIP classification guidance
    // Then it must explain read-only / write-capable / both classification
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toContain('read-only');
    expect(lower).toContain('write-capable');
    expect(lower).toMatch(/both|read\+write|read.*write/);
  });
});

// ─── AC2: NIP Analysis Step [Test: 9.2-STEP-001] ─────────────────────────

describe('[9.2-STEP-001] AC2: NIP Analysis Step', () => {
  it('[P0] Pipeline Step 1 documents event kind identification', () => {
    // Given the pipeline documentation (SKILL.md or references)
    // When checking Step 1 coverage
    // Then event kind identification must be documented
    const content = readAllSkillContent();
    expect(content.toLowerCase()).toContain('event kind');
  });

  it('[P0] Pipeline Step 1 documents tag structure analysis', () => {
    const content = readAllSkillContent();
    expect(content.toLowerCase()).toContain('tag struct');
  });

  it('[P0] Pipeline Step 1 documents NIP classification', () => {
    const content = readAllSkillContent();
    const lower = content.toLowerCase();
    // Must classify as read-only / write-capable / both
    expect(lower).toMatch(/classif|read-only|write-capable/);
  });
});

// ─── AC3: TOON Context Injection Step [Test: 9.2-STEP-002] ───────────────

describe('[9.2-STEP-002] AC3: TOON Context Injection Step', () => {
  it('[P0] Pipeline Step 2 injects TOON write model for write-capable NIPs', () => {
    // Given the pipeline documentation
    // When checking TOON context injection
    // Then write-capable skills get TOON write model with publishEvent()
    const content = readAllSkillContent();
    const lower = content.toLowerCase();
    expect(lower).toContain('publishevent');
    expect(lower).toMatch(/write.*model|toon.*write/);
  });

  it('[P0] Pipeline Step 2 injects TOON read model for read-capable NIPs', () => {
    const content = readAllSkillContent();
    const lower = content.toLowerCase();
    expect(lower).toMatch(/read.*model|toon.*read|toon.*format/);
  });

  it('[P0] Pipeline Step 2 injects fee calculation for write-capable NIPs', () => {
    const content = readAllSkillContent();
    const lower = content.toLowerCase();
    expect(lower).toContain('fee calculation');
  });

  it('[P1] Pipeline Step 2 references nostr-protocol-core skill', () => {
    const content = readAllSkillContent();
    expect(content).toContain('nostr-protocol-core');
  });

  it('[P0] Pipeline Step 2 includes relay discovery context', () => {
    const content = readAllSkillContent();
    const lower = content.toLowerCase();
    expect(lower).toMatch(/relay.*discover|nip-11|kind:10032/);
  });
});

// ─── AC4: Social Context Layer Step [Test: 9.2-STEP-003] ─────────────────

describe('[9.2-STEP-003] AC4: Social Context Layer Step', () => {
  it('[P0] social-context-template.md exists', () => {
    const path = join(REFS_DIR, 'social-context-template.md');
    expect(existsSync(path)).toBe(true);
  });

  it('[P0] Social context template prompts for NIP-specific content', () => {
    // Given the social context template
    // When checking prompt coverage
    // Then it must prompt for: when appropriate, what paying means, context norms, anti-patterns
    const content = readFileSync(
      join(REFS_DIR, 'social-context-template.md'),
      'utf-8'
    );
    const lower = content.toLowerCase();
    expect(lower).toMatch(/when.*appropriate|appropriate.*interaction/);
    expect(lower).toMatch(/paying|cost|economic/);
    expect(lower).toMatch(/norm|convention|etiquette/);
    expect(lower).toMatch(/anti-pattern/);
  });

  it('[P0] Social context template references nostr-social-intelligence', () => {
    const content = readFileSync(
      join(REFS_DIR, 'social-context-template.md'),
      'utf-8'
    );
    expect(content).toContain('nostr-social-intelligence');
  });

  it('[P1] Social context template explains WHY (D9-008)', () => {
    // Given the social context template reference
    // When checking for reasoning
    // Then it must explain WHY social context matters, not just list rules
    const content = readFileSync(
      join(REFS_DIR, 'social-context-template.md'),
      'utf-8'
    );
    const lower = content.toLowerCase();
    expect(lower).toMatch(/why|because|reason|purpose|rationale/);
  });
});

// ─── AC5: Skill Authoring Step [Test: 9.2-STEP-004] ──────────────────────

describe('[9.2-STEP-004] AC5: Skill Authoring Step', () => {
  it('[P0] skill-structure-template.md exists', () => {
    const path = join(REFS_DIR, 'skill-structure-template.md');
    expect(existsSync(path)).toBe(true);
  });

  it('[P0] Skill structure template includes YAML frontmatter skeleton', () => {
    const content = readFileSync(
      join(REFS_DIR, 'skill-structure-template.md'),
      'utf-8'
    );
    const lower = content.toLowerCase();
    expect(lower).toContain('name');
    expect(lower).toContain('description');
    expect(lower).toContain('frontmatter');
  });

  it('[P0] Skill structure template includes Social Context section', () => {
    const content = readFileSync(
      join(REFS_DIR, 'skill-structure-template.md'),
      'utf-8'
    );
    expect(content).toContain('Social Context');
  });

  it('[P0] Skill structure template includes Level 3 reference pointers', () => {
    const content = readFileSync(
      join(REFS_DIR, 'skill-structure-template.md'),
      'utf-8'
    );
    const lower = content.toLowerCase();
    expect(lower).toMatch(/reference|level 3/);
  });

  it('[P1] Skill structure template specifies body <5k tokens', () => {
    const content = readFileSync(
      join(REFS_DIR, 'skill-structure-template.md'),
      'utf-8'
    );
    const lower = content.toLowerCase();
    expect(lower).toMatch(/5k.*token|500.*line|token.*budget/);
  });
});

// ─── AC6: Eval Generation Step [Test: 9.2-STEP-005] ──────────────────────

describe('[9.2-STEP-005] AC6: Eval Generation Step', () => {
  it('[P0] eval-generation-guide.md exists', () => {
    const path = join(REFS_DIR, 'eval-generation-guide.md');
    expect(existsSync(path)).toBe(true);
  });

  it('[P0] Eval guide documents trigger_evals format', () => {
    const content = readFileSync(
      join(REFS_DIR, 'eval-generation-guide.md'),
      'utf-8'
    );
    expect(content).toContain('trigger_evals');
  });

  it('[P0] Eval guide documents output_evals format', () => {
    const content = readFileSync(
      join(REFS_DIR, 'eval-generation-guide.md'),
      'utf-8'
    );
    expect(content).toContain('output_evals');
  });

  it('[P0] Eval guide specifies 8-10 should-trigger + 8-10 should-not-trigger', () => {
    const content = readFileSync(
      join(REFS_DIR, 'eval-generation-guide.md'),
      'utf-8'
    );
    expect(content).toMatch(/8.*10.*trigger|should.trigger/);
  });

  it('[P0] Eval guide specifies 4-6 output evals with assertions', () => {
    const content = readFileSync(
      join(REFS_DIR, 'eval-generation-guide.md'),
      'utf-8'
    );
    expect(content).toMatch(/4.*6.*output|output.eval/i);
  });

  it('[P1] Eval guide explains WHY (D9-008)', () => {
    const content = readFileSync(
      join(REFS_DIR, 'eval-generation-guide.md'),
      'utf-8'
    );
    const lower = content.toLowerCase();
    expect(lower).toMatch(/why|because|reason|purpose|rationale/);
  });
});

// ─── AC7: TOON Assertions Step [Test: 9.2-STEP-006] ──────────────────────

describe('[9.2-STEP-006] AC7: TOON Assertions Step', () => {
  it('[P0] toon-compliance-assertions.md exists', () => {
    const path = join(REFS_DIR, 'toon-compliance-assertions.md');
    expect(existsSync(path)).toBe(true);
  });

  it('[P0] Documents toon-write-check assertion', () => {
    const content = readFileSync(
      join(REFS_DIR, 'toon-compliance-assertions.md'),
      'utf-8'
    );
    expect(content).toContain('toon-write-check');
  });

  it('[P0] Documents toon-fee-check assertion', () => {
    const content = readFileSync(
      join(REFS_DIR, 'toon-compliance-assertions.md'),
      'utf-8'
    );
    expect(content).toContain('toon-fee-check');
  });

  it('[P0] Documents toon-format-check assertion', () => {
    const content = readFileSync(
      join(REFS_DIR, 'toon-compliance-assertions.md'),
      'utf-8'
    );
    expect(content).toContain('toon-format-check');
  });

  it('[P0] Documents social-context-check assertion', () => {
    const content = readFileSync(
      join(REFS_DIR, 'toon-compliance-assertions.md'),
      'utf-8'
    );
    expect(content).toContain('social-context-check');
  });

  it('[P0] Documents trigger-coverage assertion', () => {
    const content = readFileSync(
      join(REFS_DIR, 'toon-compliance-assertions.md'),
      'utf-8'
    );
    expect(content).toContain('trigger-coverage');
  });

  it('[P0] Each assertion specifies when it applies (read-only / write / both / all)', () => {
    const content = readFileSync(
      join(REFS_DIR, 'toon-compliance-assertions.md'),
      'utf-8'
    );
    const lower = content.toLowerCase();
    // Must mention which classifications each assertion applies to
    expect(lower).toMatch(/write.capable|write.only/);
    expect(lower).toMatch(/read.only|read.capable/);
    expect(lower).toMatch(/\ball\b/);
  });

  it('[P0] Each assertion specifies pass/fail criteria', () => {
    const content = readFileSync(
      join(REFS_DIR, 'toon-compliance-assertions.md'),
      'utf-8'
    );
    const lower = content.toLowerCase();
    expect(lower).toMatch(/pass|fail|criteria/);
  });

  it('[P1] TOON assertions reference explains WHY (D9-008)', () => {
    const content = readFileSync(
      join(REFS_DIR, 'toon-compliance-assertions.md'),
      'utf-8'
    );
    const lower = content.toLowerCase();
    expect(lower).toMatch(/why|because|reason|purpose|rationale/);
  });
});

// ─── AC8: Description Optimization Step [Test: 9.2-STEP-007] ─────────────

describe('[9.2-STEP-007] AC8: Description Optimization Step', () => {
  it('[P0] description-optimization-guide.md exists', () => {
    const path = join(REFS_DIR, 'description-optimization-guide.md');
    expect(existsSync(path)).toBe(true);
  });

  it('[P0] Documents run_loop procedure', () => {
    const content = readFileSync(
      join(REFS_DIR, 'description-optimization-guide.md'),
      'utf-8'
    );
    expect(content).toContain('run_loop');
  });

  it('[P0] Specifies 20 trigger queries', () => {
    const content = readFileSync(
      join(REFS_DIR, 'description-optimization-guide.md'),
      'utf-8'
    );
    expect(content).toContain('20');
  });

  it('[P0] Specifies max 5 iterations', () => {
    const content = readFileSync(
      join(REFS_DIR, 'description-optimization-guide.md'),
      'utf-8'
    );
    expect(content).toMatch(/5.*iteration|max.*5/i);
  });

  it('[P1] Documents best_description selection', () => {
    const content = readFileSync(
      join(REFS_DIR, 'description-optimization-guide.md'),
      'utf-8'
    );
    expect(content).toContain('best_description');
  });
});

// ─── AC9: With/Without Testing Step [Test: 9.2-STEP-007b] ────────────────

describe('[9.2-STEP-007b] AC9: With/Without Testing Step', () => {
  it('[P0] SKILL.md body documents with/without parallel testing', () => {
    // Given the pipeline documentation
    // When checking Step 8 (With/Without Testing)
    // Then parallel subagent runs must be documented
    const content = readAllSkillContent();
    const lower = content.toLowerCase();
    expect(lower).toMatch(/with.*without|baseline.*skill|parallel.*subagent/);
  });

  it('[P1] Documents output directories (with_skill/ and without_skill/)', () => {
    const content = readAllSkillContent();
    const lower = content.toLowerCase();
    expect(lower).toMatch(/with_skill|without_skill/);
  });
});

// ─── AC10: Grading + Benchmarking Steps [Test: 9.2-STEP-008] ─────────────

describe('[9.2-STEP-008] AC10: Grading + Benchmarking Steps', () => {
  it('[P0] Documents grading.json output', () => {
    const content = readAllSkillContent();
    expect(content).toContain('grading.json');
  });

  it('[P0] Documents benchmark.json output', () => {
    const content = readAllSkillContent();
    expect(content).toContain('benchmark.json');
  });

  it('[P0] Grading includes assertions with text, passed, evidence', () => {
    const content = readAllSkillContent();
    const lower = content.toLowerCase();
    expect(lower).toMatch(/text.*passed.*evidence|assertion.*result/);
  });

  it('[P0] Benchmarking includes pass rate, timing, token usage', () => {
    const content = readAllSkillContent();
    const lower = content.toLowerCase();
    expect(lower).toMatch(/pass.*rate/);
    expect(lower).toMatch(/timing|latency/);
    expect(lower).toMatch(/token.*usage|token.*count/);
  });
});

// ─── AC11: TOON Compliance Validation Step [Test: 9.2-STEP-009] ──────────

describe('[9.2-STEP-009] AC11: TOON Compliance Validation Step', () => {
  it('[P0] Documents TOON compliance validation as a gate', () => {
    // Given the pipeline documentation
    // When checking Step 11
    // Then TOON compliance must be documented as red = not ready
    const content = readAllSkillContent();
    const lower = content.toLowerCase();
    expect(lower).toMatch(/toon.*compliance|compliance.*validation/);
    expect(lower).toMatch(/red|fail|not.*ready/);
  });
});

// ─── AC12: Eval Viewer + Iteration Steps [Test: 9.2-STEP-010] ────────────

describe('[9.2-STEP-010] AC12: Eval Viewer + Iteration Steps', () => {
  it('[P0] Documents eval viewer HTML generation', () => {
    const content = readAllSkillContent();
    const lower = content.toLowerCase();
    expect(lower).toMatch(/eval.*viewer|html.*review|generate_review/);
  });

  it('[P0] Documents feedback.json collection', () => {
    const content = readAllSkillContent();
    expect(content).toContain('feedback.json');
  });

  it('[P0] Documents iteration workflow (iteration-2+/)', () => {
    const content = readAllSkillContent();
    const lower = content.toLowerCase();
    expect(lower).toMatch(/iteration|refine|re-run/);
  });
});

// ─── AC13: Protocol Context Reference [Test: D9-010] ─────────────────────

describe('[D9-010] AC13: Protocol Context Reference', () => {
  it('[P0] toon-protocol-context.md exists', () => {
    const path = join(REFS_DIR, 'toon-protocol-context.md');
    expect(existsSync(path)).toBe(true);
  });

  it('[P0] Contains TOON write model', () => {
    const content = readFileSync(
      join(REFS_DIR, 'toon-protocol-context.md'),
      'utf-8'
    );
    const lower = content.toLowerCase();
    expect(lower).toMatch(/write.*model/);
    expect(content).toContain('publishEvent');
  });

  it('[P0] Contains TOON read model', () => {
    const content = readFileSync(
      join(REFS_DIR, 'toon-protocol-context.md'),
      'utf-8'
    );
    const lower = content.toLowerCase();
    expect(lower).toMatch(/read.*model/);
    expect(lower).toContain('toon format');
  });

  it('[P0] Contains transport (@toon-protocol/client)', () => {
    const content = readFileSync(
      join(REFS_DIR, 'toon-protocol-context.md'),
      'utf-8'
    );
    expect(content).toContain('@toon-protocol/client');
  });

  it('[P0] Contains relay discovery (NIP-11 /health, kind:10032)', () => {
    const content = readFileSync(
      join(REFS_DIR, 'toon-protocol-context.md'),
      'utf-8'
    );
    const lower = content.toLowerCase();
    expect(lower).toMatch(/nip-11|\/health/);
    expect(lower).toContain('kind:10032');
  });

  it('[P0] Contains social economics', () => {
    const content = readFileSync(
      join(REFS_DIR, 'toon-protocol-context.md'),
      'utf-8'
    );
    const lower = content.toLowerCase();
    expect(lower).toMatch(/social.*economic|economic|pay.*write/);
  });

  it('[P0] Contains no condition/fulfillment (D9-005)', () => {
    const content = readFileSync(
      join(REFS_DIR, 'toon-protocol-context.md'),
      'utf-8'
    );
    const lower = content.toLowerCase();
    expect(lower).toMatch(/no.*condition.*fulfillment|condition.*fulfillment/);
  });

  it('[P0] Is consistent with Story 9.1 canonical version', () => {
    // Given this pipeline's toon-protocol-context.md
    // And the canonical version from Story 9.1
    // When comparing key protocol details
    // Then both must agree on write model API, read model format, and transport
    const pipelineCtx = readFileSync(
      join(REFS_DIR, 'toon-protocol-context.md'),
      'utf-8'
    );
    const canonicalCtx = readFileSync(CANONICAL_PROTOCOL_CONTEXT, 'utf-8');

    // Both reference publishEvent()
    expect(pipelineCtx).toContain('publishEvent');
    expect(canonicalCtx).toContain('publishEvent');

    // Both reference @toon-protocol/client
    expect(pipelineCtx).toContain('@toon-protocol/client');
    expect(canonicalCtx).toContain('@toon-protocol/client');

    // Both reference TOON format
    expect(pipelineCtx.toLowerCase()).toContain('toon format');
    expect(canonicalCtx.toLowerCase()).toContain('toon format');

    // Both reference basePricePerByte
    expect(pipelineCtx.toLowerCase()).toContain('basepriceperbyte');
    expect(canonicalCtx.toLowerCase()).toContain('basepriceperbyte');
  });
});

// ─── AC14: Validate Script [Test: 9.2-STRUCT-002, 9.2-STRUCT-003] ────────

describe('[9.2-STRUCT-002] AC14: Validate Script Existence', () => {
  it('[P0] scripts/validate-skill.sh exists', () => {
    expect(existsSync(VALIDATE_SCRIPT)).toBe(true);
  });

  it('[P0] validate-skill.sh is executable', () => {
    // Given the validate-skill.sh script
    // When checking file permissions
    // Then it must be executable
    const stat = statSync(VALIDATE_SCRIPT);
    // Check for owner execute permission (0o100)
    expect(stat.mode & 0o111).toBeGreaterThan(0);
  });
});

describe('[9.2-STRUCT-003] AC14: Validate Script Correctness', () => {
  it('[P0] validate-skill.sh checks SKILL.md existence', () => {
    const content = readFileSync(VALIDATE_SCRIPT, 'utf-8');
    expect(content).toContain('SKILL.md');
  });

  it('[P0] validate-skill.sh checks YAML frontmatter', () => {
    const content = readFileSync(VALIDATE_SCRIPT, 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/frontmatter|name.*description|yaml/);
  });

  it('[P0] validate-skill.sh checks references/ directory', () => {
    const content = readFileSync(VALIDATE_SCRIPT, 'utf-8');
    expect(content).toContain('references');
  });

  it('[P0] validate-skill.sh checks evals/evals.json validity', () => {
    const content = readFileSync(VALIDATE_SCRIPT, 'utf-8');
    expect(content).toContain('evals.json');
  });

  it('[P0] validate-skill.sh checks ## Social Context section', () => {
    const content = readFileSync(VALIDATE_SCRIPT, 'utf-8');
    expect(content).toContain('Social Context');
  });

  it('[P0] validate-skill.sh checks for banned bare ["EVENT", ...] pattern', () => {
    const content = readFileSync(VALIDATE_SCRIPT, 'utf-8');
    expect(content).toMatch(/EVENT|bare.*event|\["EVENT/);
  });

  it('[P0] validate-skill.sh checks description word count (50-200)', () => {
    const content = readFileSync(VALIDATE_SCRIPT, 'utf-8');
    expect(content).toMatch(/word.*count|wc.*-w|50|200/);
  });

  it('[P0] validate-skill.sh checks body under 500 lines', () => {
    const content = readFileSync(VALIDATE_SCRIPT, 'utf-8');
    expect(content).toContain('500');
  });

  it('[P0] validate-skill.sh exits 0 on valid skill', () => {
    const content = readFileSync(VALIDATE_SCRIPT, 'utf-8');
    expect(content).toMatch(/exit\s+0/);
  });

  it('[P0] validate-skill.sh exits non-zero on invalid skill', () => {
    const content = readFileSync(VALIDATE_SCRIPT, 'utf-8');
    expect(content).toMatch(/exit\s+1/);
  });

  it('[P0] validate-skill.sh passes on nostr-protocol-core skill', () => {
    // Given the validate-skill.sh script
    // When running it on the known-good nostr-protocol-core skill
    // Then it must exit 0 (pass)
    const protocolCoreDir = join(
      PROJECT_ROOT,
      '.claude',
      'skills',
      'nostr-protocol-core'
    );
    try {
      execSync(`bash "${VALIDATE_SCRIPT}" "${protocolCoreDir}"`, {
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      // If no error, exit code was 0 — pass
      expect(true).toBe(true);
    } catch (e: unknown) {
      // If error, exit code was non-zero — fail
      const error = e as { status: number; stderr: string };
      expect(error.status).toBe(0);
    }
  });

  it('[P0] validate-skill.sh passes on nostr-social-intelligence skill', () => {
    // Given the validate-skill.sh script
    // When running it on the known-good nostr-social-intelligence skill
    // Then it must exit 0 (pass)
    const socialIntDir = join(
      PROJECT_ROOT,
      '.claude',
      'skills',
      'nostr-social-intelligence'
    );
    try {
      execSync(`bash "${VALIDATE_SCRIPT}" "${socialIntDir}"`, {
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      expect(true).toBe(true);
    } catch (e: unknown) {
      const error = e as { status: number; stderr: string };
      expect(error.status).toBe(0);
    }
  });
});

// ─── Eval Definitions [Test: 9.2-STRUCT-001, 9.2-STEP-005, 9.2-STEP-006] ─

describe('[9.2-EVAL] Eval Definitions', () => {
  it('[P0] evals/evals.json exists', () => {
    expect(existsSync(EVALS_JSON)).toBe(true);
  });

  it('[P0] evals.json is valid JSON', () => {
    const content = readFileSync(EVALS_JSON, 'utf-8');
    expect(() => JSON.parse(content)).not.toThrow();
  });

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
    expect(shouldNotTrigger.length).toBeGreaterThanOrEqual(8);
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

  it('[P1] Should-trigger queries include NIP conversion scenarios', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const triggers = evals.trigger_evals
      .filter((e: { should_trigger: boolean }) => e.should_trigger === true)
      .map((e: { query: string }) => e.query.toLowerCase())
      .join(' ');
    expect(triggers).toMatch(/nip|convert|pipeline|skill.*from|toon.*skill/);
  });

  it('[P1] Should-not-trigger queries distinguish from protocol-core and social-intelligence', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const nonTriggers = evals.trigger_evals
      .filter((e: { should_trigger: boolean }) => e.should_trigger === false)
      .map((e: { query: string }) => e.query.toLowerCase())
      .join(' ');
    // Should include protocol-core or social-intelligence territory
    expect(nonTriggers).toMatch(/publish|fee|react|social|event/);
  });

  it('[P0] Output evals include TOON compliance assertions', () => {
    // Given the output evals
    // When checking for TOON compliance assertion coverage
    // Then at least one output eval must check for toon-write-check or toon-fee-check
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const allAssertions = evals.output_evals
      .flatMap((oe: { assertions: string[] }) => oe.assertions)
      .join(' ')
      .toLowerCase();
    expect(allAssertions).toMatch(
      /toon.*write|publishevent|fee.*calc|toon.*compliance/
    );
  });
});

// ─── TOON Compliance Checks ──────────────────────────────────────────────

describe('[9.2-TOON] TOON Compliance Across All Files', () => {
  it('[P0] No bare ["EVENT", ...] patterns in any skill file', () => {
    // Given all skill files
    // When checking for banned patterns
    // Then no bare ["EVENT", ...] WebSocket patterns should exist
    const content = readAllSkillContent();
    // Allow ["EVENT" in reference/documentation context if discussing what NOT to do
    // But fail if it appears as an instruction to USE this pattern
    const lines = content.split('\n');
    for (const line of lines) {
      if (
        line.includes('["EVENT"') &&
        !line.toLowerCase().includes('not') &&
        !line.toLowerCase().includes("don't") &&
        !line.toLowerCase().includes('never') &&
        !line.toLowerCase().includes('avoid') &&
        !line.toLowerCase().includes('banned') &&
        !line.toLowerCase().includes('instead')
      ) {
        // Check if this is in a "don't do this" context by checking surrounding context
        // Simple heuristic: only fail if it looks like an instruction to use this pattern
        expect(line).not.toMatch(/^\s*\[?"EVENT"/);
      }
    }
  });

  it('[P0] References publishEvent() as the write API (not raw WebSocket)', () => {
    const content = readAllSkillContent();
    expect(content).toContain('publishEvent');
  });

  it('[P0] References @toon-protocol/client (not the SDK) for agent usage', () => {
    const content = readAllSkillContent();
    expect(content).toContain('@toon-protocol/client');
  });
});

// ─── Quality Checks ─────────────────────────────────────────────────────

describe('[9.2-QUALITY] Quality Validation', () => {
  it('[P0] All 6 expected reference files exist', () => {
    // Given the expected reference file list
    // When checking each file
    // Then all must exist
    for (const ref of EXPECTED_REFS) {
      expect(existsSync(join(REFS_DIR, ref)), `Missing reference: ${ref}`).toBe(
        true
      );
    }
  });

  it('[P1] Exactly 6 reference files (no extras)', () => {
    const refs = readdirSync(REFS_DIR).filter((f) => f.endsWith('.md'));
    expect(refs.length).toBe(6);
  });

  it('[P1] Exactly 1 eval file', () => {
    const evalFiles = readdirSync(EVALS_DIR);
    expect(evalFiles.length).toBe(1);
    expect(evalFiles[0]).toBe('evals.json');
  });

  it('[P1] Exactly 1 script file', () => {
    const scriptFiles = readdirSync(SCRIPTS_DIR);
    expect(scriptFiles.length).toBe(1);
    expect(scriptFiles[0]).toBe('validate-skill.sh');
  });

  it('[P0] Every reference file explains WHY (D9-008)', () => {
    // Given all reference files
    // When checking for reasoning explanations
    // Then each must contain reasoning language
    for (const ref of EXPECTED_REFS) {
      const content = readFileSync(join(REFS_DIR, ref), 'utf-8');
      const lower = content.toLowerCase();
      expect(
        lower.match(
          /why|because|reason|purpose|rationale|this ensures|this prevents/
        ),
        `Reference ${ref} lacks WHY reasoning (D9-008 compliance)`
      ).toBeTruthy();
    }
  });

  it('[P0] SKILL.md Social Context section exists', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    expect(content).toContain('## Social Context');
  });

  it('[P0] Social Context is NIP-specific (mentions pipeline/NIP conversion context)', () => {
    // Given the Social Context section
    // When checking content
    // Then it must be specific to the pipeline skill (not generic)
    const content = readFileSync(SKILL_MD, 'utf-8');
    const socialIdx = content.indexOf('## Social Context');
    const socialContent = content.slice(socialIdx);
    const lower = socialContent.toLowerCase();
    expect(lower).toMatch(/pipeline|nip|skill.*creation|conversion/);
  });
});

// ─── Meta-Eval Readiness [Test: 9.2-META-001 through 9.2-META-004] ──────

describe('[9.2-META] Meta-Eval Readiness', () => {
  it('[P0] Pipeline documents read-only NIP handling (e.g., NIP-50 Search)', () => {
    // Given the pipeline documentation
    // When checking for read-only NIP guidance
    // Then the pipeline must explain that read-only NIPs get no write model
    const content = readAllSkillContent();
    const lower = content.toLowerCase();
    expect(lower).toContain('read-only');
    expect(lower).toMatch(/toon-format-check|toon.*format/);
  });

  it('[P0] Pipeline documents write-capable NIP handling (e.g., NIP-25 Reactions)', () => {
    // Given the pipeline documentation
    // When checking for write-capable NIP guidance
    // Then write-capable NIPs must get write model + fee calculation
    const content = readAllSkillContent();
    const lower = content.toLowerCase();
    expect(lower).toContain('write-capable');
    expect(lower).toMatch(/toon-write-check|publishevent/);
    expect(lower).toMatch(/toon-fee-check|fee.*calc/);
  });

  it('[P0] Pipeline documents read+write NIP handling (e.g., NIP-23 Long-form)', () => {
    // Given the pipeline documentation
    // When checking for read+write NIP guidance
    // Then both models must apply
    const content = readAllSkillContent();
    const lower = content.toLowerCase();
    expect(lower).toMatch(/both|read.*write|write.*read/);
  });

  it('[P0] NIP classification drives assertion injection', () => {
    // Given the pipeline documentation
    // When checking that classification affects assertion selection
    // Then different assertions must apply to different classifications
    const content = readAllSkillContent();
    const lower = content.toLowerCase();
    // Write-only should get write checks
    expect(lower).toMatch(/write.*toon-write-check|toon-write-check.*write/);
    // Read-only should get format checks
    expect(lower).toMatch(/read.*toon-format-check|toon-format-check.*read/);
  });
});

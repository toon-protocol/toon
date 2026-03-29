/**
 * ATDD: Story 9.0 — Social Intelligence Base Skill (nostr-social-intelligence)
 *
 * Structural validation tests for the nostr-social-intelligence Claude Agent Skill.
 * This story produces markdown + JSON files, NOT TypeScript code.
 * Tests validate file existence, format compliance, content coverage, and eval structure.
 *
 * TDD GREEN PHASE: Skill files now exist — all tests enabled.
 *
 * @see _bmad-output/implementation-artifacts/9-0-social-intelligence-base-skill.md
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve, join } from 'path';
import { parse as parseYaml } from 'yaml';

// Resolve project root (vitest runs from repo root)
const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const SKILL_DIR = join(
  PROJECT_ROOT,
  '.claude',
  'skills',
  'nostr-social-intelligence'
);
const REFS_DIR = join(SKILL_DIR, 'references');
const EVALS_DIR = join(SKILL_DIR, 'evals');
const SKILL_MD = join(SKILL_DIR, 'SKILL.md');
const EVALS_JSON = join(EVALS_DIR, 'evals.json');

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

// ─── AC1: SKILL.md Core File [Test: 9.0-STRUCT-001] ───────────────────────

describe('[9.0-STRUCT-001] AC1: SKILL.md Core File', () => {
  it('[P0] SKILL.md exists at .claude/skills/nostr-social-intelligence/SKILL.md', () => {
    // Given the nostr-social-intelligence skill directory
    // When checking for the core SKILL.md file
    // Then it must exist
    expect(existsSync(SKILL_MD)).toBe(true);
  });

  it('[P0] SKILL.md has valid YAML frontmatter with name and description', () => {
    // Given the SKILL.md file
    // When parsing the YAML frontmatter
    // Then it must contain exactly name and description fields
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter).toHaveProperty('name', 'nostr-social-intelligence');
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

  it('[P1] SKILL.md body is under 500 lines', () => {
    // Given the SKILL.md file
    // When counting lines in the body (after frontmatter)
    // Then body must be under 500 lines (progressive disclosure)
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lineCount = body.split('\n').length;
    expect(lineCount).toBeLessThan(500);
  });

  it('[P1] SKILL.md body contains "When to read each reference" guidance', () => {
    // Given the SKILL.md body
    // When checking for reference guidance section
    // Then it must describe when to read each reference file
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    // Accept variations: "When to read", "when to load", or reference file mentions
    expect(body.toLowerCase()).toMatch(
      /when to (read|load|consult) each reference/i
    );
  });

  it('[P1] SKILL.md body uses imperative/infinitive form (no "you should")', () => {
    // Given the SKILL.md body
    // When checking for writing style compliance
    // Then it should use imperative form per skill-creator guidelines
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    // "You should" is the primary anti-pattern for imperative form
    const youShouldCount = (body.match(/\byou should\b/gi) || []).length;
    expect(youShouldCount).toBe(0);
  });
});

// ─── AC2: Description Triggers [Test: 9.0-TRIGGER-001] ────────────────────

describe('[9.0-TRIGGER-001] AC2: Description Triggers on Social Situations', () => {
  it('[P0] description includes interaction choice triggers', () => {
    // Given the SKILL.md description field
    // When checking for interaction choice trigger phrases
    // Then it must include phrases like "should I react", "should I comment", etc.
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    const hasInteractionChoice =
      desc.includes('react') ||
      desc.includes('comment') ||
      desc.includes('repost') ||
      desc.includes('interaction type');
    expect(hasInteractionChoice).toBe(true);
  });

  it('[P0] description includes social judgment triggers', () => {
    // Given the SKILL.md description field
    // When checking for social judgment trigger phrases
    // Then it must include phrases like "appropriate", "how should I engage"
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    const hasSocialJudgment =
      desc.includes('appropriate') ||
      desc.includes('engage') ||
      desc.includes('social judgment');
    expect(hasSocialJudgment).toBe(true);
  });

  it('[P0] description includes community norms triggers', () => {
    // Given the SKILL.md description field
    // When checking for community norms trigger phrases
    // Then it must include phrases like "etiquette", "norms", "conventions", or "culture"
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    const hasCommunityNorms =
      desc.includes('etiquette') ||
      desc.includes('norms') ||
      desc.includes('conventions') ||
      desc.includes('culture');
    expect(hasCommunityNorms).toBe(true);
  });

  it('[P0] description includes conflict handling triggers', () => {
    // Given the SKILL.md description field
    // When checking for conflict handling trigger phrases
    // Then it must include phrases like "disagreement", "mute", "block", "report"
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    const hasConflict =
      desc.includes('disagreement') ||
      desc.includes('conflict') ||
      desc.includes('mute') ||
      desc.includes('block');
    expect(hasConflict).toBe(true);
  });

  it('[P0] description includes TOON economics triggers', () => {
    // Given the SKILL.md description field
    // When checking for TOON economics trigger phrases
    // Then it must include phrases about economics, cost, payment, or ILP
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    const hasEconomics =
      desc.includes('economics') ||
      desc.includes('cost') ||
      desc.includes('payment') ||
      desc.includes('ilp');
    expect(hasEconomics).toBe(true);
  });

  it('[P1] description is between 80-120 words', () => {
    // Given the SKILL.md description field
    // When counting words
    // Then word count is between 80-120 (comprehensive but concise)
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const wordCount = (frontmatter.description as string)
      .split(/\s+/)
      .filter(Boolean).length;
    expect(wordCount).toBeGreaterThanOrEqual(80);
    expect(wordCount).toBeLessThanOrEqual(120);
  });
});

// ─── AC3: Interaction Decisions Reference [Test: 9.0-STRUCT-002] ──────────

describe('[9.0-STRUCT-002] AC3: Interaction Decisions Reference', () => {
  it('[P0] references/interaction-decisions.md exists', () => {
    // Given the skill references directory
    // When checking for interaction-decisions.md
    // Then the file must exist
    expect(existsSync(join(REFS_DIR, 'interaction-decisions.md'))).toBe(true);
  });

  it('[P0] interaction-decisions.md contains decision tree with amplification, comment, react, silence', () => {
    // Given the interaction-decisions reference file
    // When checking for the required decision tree nodes
    // Then all four decision points must be present
    const content = readFileSync(
      join(REFS_DIR, 'interaction-decisions.md'),
      'utf-8'
    ).toLowerCase();
    expect(content).toMatch(/amplif/); // amplification/amplify
    expect(content).toMatch(/comment/);
    expect(content).toMatch(/react/);
    expect(content).toMatch(/silence/);
  });

  it('[P1] interaction-decisions.md includes context modifiers (group size, feed vs DM, long-form)', () => {
    // Given the interaction-decisions reference file
    // When checking for context modifiers
    // Then group size, feed vs DM, and long-form modifiers must be addressed
    const content = readFileSync(
      join(REFS_DIR, 'interaction-decisions.md'),
      'utf-8'
    ).toLowerCase();
    expect(content).toMatch(/group size/);
    expect(content).toMatch(/dm|direct message/);
    expect(content).toMatch(/long.?form/);
  });
});

// ─── AC4: Context Norms Reference [Test: 9.0-STRUCT-003] ─────────────────

describe('[9.0-STRUCT-003] AC4: Context Norms Reference', () => {
  it('[P0] references/context-norms.md exists', () => {
    expect(existsSync(join(REFS_DIR, 'context-norms.md'))).toBe(true);
  });

  it('[P0] context-norms.md covers all 5 context types', () => {
    // Given the context-norms reference file
    // When checking for the required context types
    // Then public feed, small groups, large groups, DMs, and long-form must be addressed
    const content = readFileSync(
      join(REFS_DIR, 'context-norms.md'),
      'utf-8'
    ).toLowerCase();
    expect(content).toMatch(/public feed/);
    expect(content).toMatch(/small.*group|nip.?29/);
    expect(content).toMatch(/large.*group/);
    expect(content).toMatch(/dm|direct message/);
    expect(content).toMatch(/long.?form/);
  });
});

// ─── AC5: Trust Signals Reference [Test: 9.0-STRUCT-004] ─────────────────

describe('[9.0-STRUCT-004] AC5: Trust Signals Reference', () => {
  it('[P0] references/trust-signals.md exists', () => {
    expect(existsSync(join(REFS_DIR, 'trust-signals.md'))).toBe(true);
  });

  it('[P0] trust-signals.md covers follow count, relay membership, NIP-05, and new accounts', () => {
    // Given the trust-signals reference file
    // When checking for the required trust signal topics
    // Then all four topics must be addressed
    const content = readFileSync(
      join(REFS_DIR, 'trust-signals.md'),
      'utf-8'
    ).toLowerCase();
    expect(content).toMatch(/follow.*count|follower/);
    expect(content).toMatch(/relay.*membership|ilp.?gated/);
    expect(content).toMatch(/nip.?05/);
    expect(content).toMatch(/new account/);
  });
});

// ─── AC6: Conflict Resolution Reference [Test: 9.0-STRUCT-005] ───────────

describe('[9.0-STRUCT-005] AC6: Conflict Resolution Reference', () => {
  it('[P0] references/conflict-resolution.md exists', () => {
    expect(existsSync(join(REFS_DIR, 'conflict-resolution.md'))).toBe(true);
  });

  it('[P0] conflict-resolution.md covers escalation ladder: ignore, mute (NIP-51), block, report (NIP-56)', () => {
    // Given the conflict-resolution reference file
    // When checking for the escalation ladder steps
    // Then all steps must be documented
    const content = readFileSync(
      join(REFS_DIR, 'conflict-resolution.md'),
      'utf-8'
    ).toLowerCase();
    expect(content).toMatch(/ignore/);
    expect(content).toMatch(/mute/);
    expect(content).toMatch(/nip.?51/);
    expect(content).toMatch(/block/);
    expect(content).toMatch(/report/);
    expect(content).toMatch(/nip.?56/);
  });

  it('[P1] conflict-resolution.md addresses NIP-29 group conflict (defer to admins)', () => {
    const content = readFileSync(
      join(REFS_DIR, 'conflict-resolution.md'),
      'utf-8'
    ).toLowerCase();
    expect(content).toMatch(/nip.?29/);
    expect(content).toMatch(/admin/);
  });
});

// ─── AC7: Pseudonymous Culture Reference [Test: 9.0-STRUCT-006] ──────────

describe('[9.0-STRUCT-006] AC7: Pseudonymous Culture Reference', () => {
  it('[P0] references/pseudonymous-culture.md exists', () => {
    expect(existsSync(join(REFS_DIR, 'pseudonymous-culture.md'))).toBe(true);
  });

  it('[P0] pseudonymous-culture.md covers identity, relay diversity, ILP quality, censorship resistance, interoperability', () => {
    const content = readFileSync(
      join(REFS_DIR, 'pseudonymous-culture.md'),
      'utf-8'
    ).toLowerCase();
    expect(content).toMatch(/identity|keys/);
    expect(content).toMatch(/relay diversity/);
    expect(content).toMatch(/ilp.?gated|quality floor/);
    expect(content).toMatch(/censorship resistance/);
    expect(content).toMatch(/interoperab/);
  });
});

// ─── AC8: Economics of Interaction Reference [Test: 9.0-STRUCT-007] ───────

describe('[9.0-STRUCT-007] AC8: Economics of Interaction Reference', () => {
  it('[P0] references/economics-of-interaction.md exists', () => {
    expect(existsSync(join(REFS_DIR, 'economics-of-interaction.md'))).toBe(
      true
    );
  });

  it('[P0] economics-of-interaction.md covers reactions cost, long-form cost, chat cost, deletion cost', () => {
    // Given the economics-of-interaction reference file
    // When checking for ILP cost topics
    // Then reactions, long-form, chat, and deletion costs must be addressed
    const content = readFileSync(
      join(REFS_DIR, 'economics-of-interaction.md'),
      'utf-8'
    ).toLowerCase();
    expect(content).toMatch(/reaction/);
    expect(content).toMatch(/long.?form/);
    expect(content).toMatch(/chat|message/);
    expect(content).toMatch(/delet/);
  });

  it('[P1] economics-of-interaction.md mentions basePricePerByte or per-byte pricing', () => {
    const content = readFileSync(
      join(REFS_DIR, 'economics-of-interaction.md'),
      'utf-8'
    ).toLowerCase();
    expect(content).toMatch(/basepriceperbyte|per.?byte/);
  });
});

// ─── AC9: Anti-Patterns Reference [Test: 9.0-STRUCT-008] ─────────────────

describe('[9.0-STRUCT-008] AC9: Anti-Patterns Reference', () => {
  it('[P0] references/anti-patterns.md exists', () => {
    expect(existsSync(join(REFS_DIR, 'anti-patterns.md'))).toBe(true);
  });

  it('[P0] anti-patterns.md documents all 7 anti-patterns', () => {
    // Given the anti-patterns reference file
    // When checking for the 7 required anti-patterns
    // Then all must be documented with descriptions and remedies
    const content = readFileSync(
      join(REFS_DIR, 'anti-patterns.md'),
      'utf-8'
    ).toLowerCase();
    expect(content).toMatch(/over.?reactor/);
    expect(content).toMatch(/template responder/);
    expect(content).toMatch(/context.?blind/);
    expect(content).toMatch(/engagement maximizer/);
    expect(content).toMatch(/sycophant/);
    expect(content).toMatch(/over.?explainer/);
    expect(content).toMatch(/instant responder/);
  });

  it('[P1] anti-patterns.md includes remedies for each anti-pattern', () => {
    const content = readFileSync(
      join(REFS_DIR, 'anti-patterns.md'),
      'utf-8'
    ).toLowerCase();
    // Check for remedy/solution language near each anti-pattern
    expect(content).toMatch(/remed|instead|solution|fix|alternative/);
  });
});

// ─── AC10: Eval Definitions [Test: 9.0-EVAL-001] ─────────────────────────

describe('[9.0-EVAL-001] AC10: Eval Definitions', () => {
  it('[P0] evals/evals.json exists', () => {
    expect(existsSync(EVALS_JSON)).toBe(true);
  });

  it('[P0] evals.json is valid JSON', () => {
    // Given the evals.json file
    // When parsing as JSON
    // Then it must parse without error
    const content = readFileSync(EVALS_JSON, 'utf-8');
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it('[P0] evals.json has trigger_evals array with should_trigger and should_not_trigger entries', () => {
    // Given the parsed evals.json
    // When checking structure
    // Then trigger_evals must contain both should_trigger=true and should_trigger=false entries
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    expect(evals).toHaveProperty('trigger_evals');
    expect(Array.isArray(evals.trigger_evals)).toBe(true);

    const shouldTrigger = evals.trigger_evals.filter(
      (e: { should_trigger: boolean }) => e.should_trigger === true
    );
    const shouldNotTrigger = evals.trigger_evals.filter(
      (e: { should_trigger: boolean }) => e.should_trigger === false
    );

    expect(shouldTrigger.length).toBeGreaterThanOrEqual(8);
    expect(shouldNotTrigger.length).toBeGreaterThanOrEqual(8);
  });

  it('[P0] evals.json has output_evals array with 4-6 entries', () => {
    // Given the parsed evals.json
    // When checking output_evals
    // Then it must contain 4-6 output eval entries
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    expect(evals).toHaveProperty('output_evals');
    expect(Array.isArray(evals.output_evals)).toBe(true);
    expect(evals.output_evals.length).toBeGreaterThanOrEqual(4);
    expect(evals.output_evals.length).toBeLessThanOrEqual(6);
  });

  it('[P0] output_evals use rubric-based grading (appropriate/acceptable/inappropriate)', () => {
    // Given each output eval entry
    // When checking for rubric-based grading
    // Then rubric object must contain appropriate/acceptable/inappropriate keys
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    for (const entry of evals.output_evals) {
      expect(entry).toHaveProperty('rubric');
      expect(entry.rubric).toHaveProperty('appropriate');
      expect(entry.rubric).toHaveProperty('acceptable');
      expect(entry.rubric).toHaveProperty('inappropriate');
    }
  });

  it('[P1] each trigger_eval has query and should_trigger fields', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    for (const entry of evals.trigger_evals) {
      expect(entry).toHaveProperty('query');
      expect(entry).toHaveProperty('should_trigger');
      expect(typeof entry.query).toBe('string');
      expect(typeof entry.should_trigger).toBe('boolean');
    }
  });

  it('[P1] each output_eval has id, prompt, rubric, and assertions', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    for (const entry of evals.output_evals) {
      expect(entry).toHaveProperty('id');
      expect(entry).toHaveProperty('prompt');
      expect(entry).toHaveProperty('rubric');
      expect(entry).toHaveProperty('assertions');
      expect(Array.isArray(entry.assertions)).toBe(true);
    }
  });
});

// ─── Quality Validation (AC: all) ─────────────────────────────────────────

describe('[9.0-QUALITY] Structural Quality Validation', () => {
  it('[P0] skill directory contains exactly the expected files (no extraneous files)', () => {
    // Given the skill directory
    // When listing all files
    // Then only SKILL.md, references/, and evals/ should exist (no README, CHANGELOG, etc.)
    expect(existsSync(SKILL_DIR)).toBe(true);
    const topLevel = readdirSync(SKILL_DIR);
    // Should contain SKILL.md, references, evals — nothing else
    expect(topLevel.sort()).toEqual(['SKILL.md', 'evals', 'references'].sort());
  });

  it('[P0] all 7 reference files exist and are non-empty', () => {
    const expectedFiles = [
      'interaction-decisions.md',
      'context-norms.md',
      'trust-signals.md',
      'conflict-resolution.md',
      'pseudonymous-culture.md',
      'economics-of-interaction.md',
      'anti-patterns.md',
    ];
    for (const file of expectedFiles) {
      const path = join(REFS_DIR, file);
      expect(existsSync(path), `${file} should exist`).toBe(true);
      const content = readFileSync(path, 'utf-8');
      expect(
        content.trim().length,
        `${file} should be non-empty`
      ).toBeGreaterThan(0);
    }
  });

  it('[P0] references directory contains exactly 7 files (no extras)', () => {
    const files = readdirSync(REFS_DIR);
    expect(files.length).toBe(7);
  });

  it('[P1] every reference file explains WHY (reasoning), not just rules (D9-008)', () => {
    // Given each reference file
    // When checking for reasoning language
    // Then each file should contain "because", "reason", "why", or similar explanatory language
    const expectedFiles = [
      'interaction-decisions.md',
      'context-norms.md',
      'trust-signals.md',
      'conflict-resolution.md',
      'pseudonymous-culture.md',
      'economics-of-interaction.md',
      'anti-patterns.md',
    ];
    for (const file of expectedFiles) {
      const content = readFileSync(join(REFS_DIR, file), 'utf-8').toLowerCase();
      const hasReasoning =
        /\bbecause\b|\breason\b|\bwhy\b|\bsince\b|\bthis means\b/.test(content);
      expect(
        hasReasoning,
        `${file} should explain WHY (D9-008 compliance)`
      ).toBe(true);
    }
  });

  it('[P0] evals directory contains exactly 1 file (evals.json, no extras)', () => {
    const files = readdirSync(EVALS_DIR);
    expect(files).toEqual(['evals.json']);
  });
});

// ─── Gap Coverage: AC1 Decision Framework in Body ──────────────────────────

describe('[9.0-STRUCT-001] AC1: SKILL.md Core Decision Framework', () => {
  it('[P1] SKILL.md body contains a multi-step decision framework', () => {
    // Given the SKILL.md body
    // When checking for the core decision framework
    // Then it must contain the sequential decision steps (context, content, interaction type, economics, anti-patterns)
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/assess context/);
    expect(lower).toMatch(/evaluate content/);
    expect(lower).toMatch(/choose interaction type/);
    expect(lower).toMatch(/consider economics/);
    expect(lower).toMatch(/check for anti.?patterns/);
  });

  it('[P1] SKILL.md body contains cross-skill integration guidance', () => {
    // Given the SKILL.md body
    // When checking for integration guidance
    // Then it must reference nostr-protocol-core and explain skill boundaries
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/nostr-protocol-core/);
    expect(body.toLowerCase()).toMatch(/protocol/);
  });
});

// ─── Gap Coverage: AC3 Decision Tree Ordering ──────────────────────────────

describe('[9.0-STRUCT-002] AC3: Interaction Decision Tree Ordering', () => {
  it('[P1] decision tree presents amplification before comment before react before silence', () => {
    // Given the interaction-decisions reference file
    // When checking the ordering of decision nodes
    // Then amplification must appear before comment, comment before react, react before silence
    const content = readFileSync(
      join(REFS_DIR, 'interaction-decisions.md'),
      'utf-8'
    ).toLowerCase();
    const amplifyPos = content.indexOf('amplification');
    const commentPos = content.indexOf('substantive thoughts');
    const reactPos = content.indexOf('acknowledge without');
    const silencePos = content.indexOf('nothing to add');
    expect(amplifyPos).toBeGreaterThan(-1);
    expect(commentPos).toBeGreaterThan(-1);
    expect(reactPos).toBeGreaterThan(-1);
    expect(silencePos).toBeGreaterThan(-1);
    expect(amplifyPos).toBeLessThan(commentPos);
    expect(commentPos).toBeLessThan(reactPos);
    expect(reactPos).toBeLessThan(silencePos);
  });

  it('[P1] amplification step mentions repost and quote', () => {
    // Given the interaction-decisions reference file
    // When checking the amplification decision node
    // Then it must mention repost and quote as amplification options
    const content = readFileSync(
      join(REFS_DIR, 'interaction-decisions.md'),
      'utf-8'
    ).toLowerCase();
    expect(content).toMatch(/repost/);
    expect(content).toMatch(/quote/);
  });
});

// ─── Gap Coverage: AC4 Context-Specific Behavioral Norms ──────────────────

describe('[9.0-STRUCT-003] AC4: Context Norms Behavioral Detail', () => {
  it('[P1] each context type specifies reaction and comment norms', () => {
    // Given the context-norms reference file
    // When checking each context section
    // Then each must describe both reaction behavior and comment behavior
    const content = readFileSync(
      join(REFS_DIR, 'context-norms.md'),
      'utf-8'
    ).toLowerCase();

    // Public feed: liberal reactions, substantive comments
    expect(content).toMatch(/public feed[\s\S]*?liberal/);
    expect(content).toMatch(/public feed[\s\S]*?substantive/);

    // Small NIP-29 groups: thoughtful reactions, encouraged comments
    expect(content).toMatch(/small[\s\S]*?thoughtful/);
    expect(content).toMatch(/small[\s\S]*?encouraged/);

    // Large groups: free reactions, focused comments
    expect(content).toMatch(/large group[\s\S]*?free/);
    expect(content).toMatch(/large group[\s\S]*?focused/);

    // DMs: direct, personal
    expect(content).toMatch(/direct message[\s\S]*?direct|dm[\s\S]*?direct/);

    // Long-form: considered, detailed
    expect(content).toMatch(/long.?form[\s\S]*?considered/);
  });
});

// ─── Gap Coverage: AC5 Trust Signal Priority ───────────────────────────────

describe('[9.0-STRUCT-004] AC5: Trust Signal Composite Assessment', () => {
  it('[P1] trust-signals.md establishes content quality as strongest signal', () => {
    // Given the trust-signals reference file
    // When checking for trust signal prioritization
    // Then content quality must be identified as the strongest/primary signal
    const content = readFileSync(
      join(REFS_DIR, 'trust-signals.md'),
      'utf-8'
    ).toLowerCase();
    expect(content).toMatch(/content quality[\s\S]*?strongest signal/);
  });

  it('[P1] trust-signals.md includes composite trust assessment guidance', () => {
    // Given the trust-signals reference file
    // When checking for composite assessment
    // Then it must describe evaluating multiple signals together
    const content = readFileSync(
      join(REFS_DIR, 'trust-signals.md'),
      'utf-8'
    ).toLowerCase();
    expect(content).toMatch(/composite|multiple signals/);
  });
});

// ─── Gap Coverage: AC8 Relay Membership Economic Proof ─────────────────────

describe('[9.0-STRUCT-007] AC8: Economics Relay Membership', () => {
  it('[P1] economics-of-interaction.md documents relay membership as economic proof', () => {
    // Given the economics-of-interaction reference file
    // When checking for relay membership content
    // Then it must document how relay membership on ILP-gated relays is a trust signal
    const content = readFileSync(
      join(REFS_DIR, 'economics-of-interaction.md'),
      'utf-8'
    ).toLowerCase();
    expect(content).toMatch(/relay membership/);
    expect(content).toMatch(/economic proof|trust signal|skin.?in.?the.?game/);
  });
});

// ─── Gap Coverage: AC9 Per-Anti-Pattern Remedies ───────────────────────────

describe('[9.0-STRUCT-008] AC9: Per-Anti-Pattern Remedy Verification', () => {
  it('[P0] each of the 7 anti-patterns has a dedicated remedy section', () => {
    // Given the anti-patterns reference file
    // When checking each anti-pattern
    // Then each must have an associated remedy/alternative
    const content = readFileSync(join(REFS_DIR, 'anti-patterns.md'), 'utf-8');
    const antiPatterns = [
      'Over-Reactor',
      'Template Responder',
      'Context-Blind',
      'Engagement Maximizer',
      'Sycophant',
      'Over-Explainer',
      'Instant Responder',
    ];
    for (const pattern of antiPatterns) {
      // Find the anti-pattern section
      const patternIndex = content.indexOf(pattern);
      expect(
        patternIndex,
        `${pattern} should exist in anti-patterns.md`
      ).toBeGreaterThan(-1);

      // Check that "Remedy" appears after this anti-pattern (within a reasonable range, before the next anti-pattern or end)
      const afterPattern = content.slice(patternIndex);
      expect(afterPattern, `${pattern} should have a Remedy section`).toMatch(
        /\*\*Remedy/
      );
    }
  });
});

// ─── Gap Coverage: AC10 Eval Content Quality ───────────────────────────────

describe('[9.0-EVAL-001] AC10: Eval Content Quality', () => {
  it('[P1] should-trigger queries cover social-situation scenarios (not protocol-only)', () => {
    // Given the trigger_evals with should_trigger=true
    // When checking their content
    // Then they should reference social situations (react, comment, appropriate, engage, norms, conflict)
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const shouldTrigger = evals.trigger_evals.filter(
      (e: { should_trigger: boolean }) => e.should_trigger === true
    );
    // At least 5 of the should-trigger queries must contain social-situation keywords
    const socialKeywords =
      /react|comment|repost|appropriate|engage|norms|disagree|mute|block|social|conflict|etiquette/i;
    const socialCount = shouldTrigger.filter((e: { query: string }) =>
      socialKeywords.test(e.query)
    ).length;
    expect(socialCount).toBeGreaterThanOrEqual(5);
  });

  it('[P1] should-not-trigger queries are protocol-only (distinguishable from social intelligence)', () => {
    // Given the trigger_evals with should_trigger=false
    // When checking their content
    // Then they should reference protocol mechanics (construct, format, fee, BTP, wire, sign, kind, NIP)
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const shouldNotTrigger = evals.trigger_evals.filter(
      (e: { should_trigger: boolean }) => e.should_trigger === false
    );
    const protocolKeywords =
      /construct|format|fee|calculate|btp|wire|sign|packet|field|set up|kind:\d/i;
    const protocolCount = shouldNotTrigger.filter((e: { query: string }) =>
      protocolKeywords.test(e.query)
    ).length;
    expect(protocolCount).toBeGreaterThanOrEqual(5);
  });

  it('[P1] output_evals each have a non-empty prompt and at least 2 assertions', () => {
    // Given each output eval entry
    // When checking quality
    // Then prompts must be substantive and assertions array must have at least 2 entries
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    for (const entry of evals.output_evals) {
      expect(
        entry.prompt.length,
        `output eval ${entry.id} prompt should be substantive`
      ).toBeGreaterThan(50);
      expect(
        entry.assertions.length,
        `output eval ${entry.id} should have at least 2 assertions`
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it('[P1] rubric descriptions are substantive (not placeholder text)', () => {
    // Given each output eval rubric
    // When checking description lengths
    // Then each category (appropriate/acceptable/inappropriate) should have meaningful descriptions
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    for (const entry of evals.output_evals) {
      expect(
        entry.rubric.appropriate.length,
        `${entry.id} rubric.appropriate should be substantive`
      ).toBeGreaterThan(50);
      expect(
        entry.rubric.acceptable.length,
        `${entry.id} rubric.acceptable should be substantive`
      ).toBeGreaterThan(50);
      expect(
        entry.rubric.inappropriate.length,
        `${entry.id} rubric.inappropriate should be substantive`
      ).toBeGreaterThan(50);
    }
  });
});

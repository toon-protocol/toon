/**
 * ATDD: Story 9.8 — Relay Groups Skill (relay-groups)
 *
 * Structural validation tests for the relay-groups Claude Agent Skill.
 * This story produces markdown + JSON files, NOT TypeScript code.
 * Tests validate file existence, format compliance, content coverage, eval structure,
 * TOON compliance, dependency references, and social context appropriateness.
 *
 * Classification: "both" (read + write). NIP-29 relay-enforced groups.
 *
 * Test IDs from test-design-epic-9.md Standard Skill Validation Template:
 *   STRUCT-A, STRUCT-B, STRUCT-C, STRUCT-D
 *   EVAL-A, EVAL-B
 *   TOON-A, TOON-B, TOON-C, TOON-D
 *   BASE-A
 *   DEP-A
 *
 * @see _bmad-output/implementation-artifacts/9-8-relay-groups-skill.md
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve, join } from 'path';
import { parse as parseYaml } from 'yaml';

// Resolve project root (vitest runs from repo root)
const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const SKILL_DIR = join(PROJECT_ROOT, '.claude', 'skills', 'relay-groups');
const REFS_DIR = join(SKILL_DIR, 'references');
const EVALS_DIR = join(SKILL_DIR, 'evals');
const SKILL_MD = join(SKILL_DIR, 'SKILL.md');
const EVALS_JSON = join(EVALS_DIR, 'evals.json');

// Expected reference files
const EXPECTED_REFS = ['nip-spec.md', 'toon-extensions.md', 'scenarios.md'];

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

// ─── AC1: Pipeline Production [Test: STRUCT-A, STRUCT-B] ─────────────────

describe('[STRUCT-A] AC1: Directory Layout', () => {
  it('[P0] SKILL.md exists at .claude/skills/relay-groups/SKILL.md', () => {
    expect(existsSync(SKILL_MD)).toBe(true);
  });

  it('[P0] references/ directory exists', () => {
    expect(existsSync(REFS_DIR)).toBe(true);
  });

  it('[P0] evals/ directory exists', () => {
    expect(existsSync(EVALS_DIR)).toBe(true);
  });

  it('[P0] evals/evals.json exists', () => {
    expect(existsSync(EVALS_JSON)).toBe(true);
  });

  it('[P0] skill directory contains exactly SKILL.md, references/, evals/ (no extraneous files)', () => {
    expect(existsSync(SKILL_DIR)).toBe(true);
    const topLevel = readdirSync(SKILL_DIR);
    expect(topLevel.sort()).toEqual(['SKILL.md', 'evals', 'references'].sort());
  });

  it('[P0] references/ contains exactly the expected files', () => {
    const refFiles = readdirSync(REFS_DIR);
    expect(refFiles.sort()).toEqual(EXPECTED_REFS.sort());
  });
});

describe('[STRUCT-B] AC1: Frontmatter Validity', () => {
  it('[P0] SKILL.md has valid YAML frontmatter with name and description', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter).toHaveProperty('name', 'relay-groups');
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
});

// ─── AC2: NIP Coverage [Test: EVAL-A, EVAL-B] ───────────────────────────

describe('[EVAL-A, EVAL-B] AC2: NIP-29 Coverage', () => {
  it('[P0] SKILL.md body covers relay-as-authority model', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toContain('relay');
    expect(lower).toContain('authority');
    expect(lower).toMatch(/membership|member/);
    expect(lower).toMatch(/enforc|validat/);
  });

  it('[P0] SKILL.md body covers h tag', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/`h` tag|h tag|\["h"/);
    expect(body).toMatch(/group.?id|group ID/i);
  });

  it('[P0] SKILL.md body covers group messages (kind:9 and kind:11)', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/kind:9\b/);
    expect(body).toMatch(/kind:11\b/);
    expect(body.toLowerCase()).toMatch(/chat|message/);
    expect(body.toLowerCase()).toMatch(/thread/);
  });

  it('[P0] SKILL.md body covers group metadata (kind:39000)', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/kind:39000/);
    expect(body.toLowerCase()).toMatch(/metadata/);
  });

  it('[P0] SKILL.md body covers admin list (kind:39001) and member list (kind:39002)', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/kind:39001/);
    expect(body).toMatch(/kind:39002/);
    expect(body.toLowerCase()).toMatch(/admin/);
    expect(body.toLowerCase()).toMatch(/member/);
  });

  it('[P0] SKILL.md body covers admin/moderation events (kind:9000-9009)', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    // Must cover the range of admin kinds
    expect(body).toMatch(/kind:9000/);
    expect(body).toMatch(/kind:9001/);
    expect(body).toMatch(/kind:9005/);
    expect(body).toMatch(/kind:9007/);
    expect(body).toMatch(/kind:9009/);
  });

  it('[P0] SKILL.md body covers permissions model', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/permission/);
    expect(lower).toMatch(/add-user/);
    expect(lower).toMatch(/edit-metadata/);
    expect(lower).toMatch(/delete-event/);
  });

  it('[P0] SKILL.md body covers open vs closed groups', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/open/);
    expect(lower).toMatch(/closed/);
  });

  it('[P0] SKILL.md body covers group invites (kind:9009)', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/kind:9009/);
    expect(body.toLowerCase()).toMatch(/invite/);
  });

  it('[P0] nip-spec.md covers NIP-29 event kinds comprehensively', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    // All admin event kinds
    for (const kind of [
      9000, 9001, 9002, 9003, 9004, 9005, 9006, 9007, 9008, 9009,
    ]) {
      expect(content).toContain(`kind:${kind}`);
    }
    // Group state event kinds
    expect(content).toContain('kind:39000');
    expect(content).toContain('kind:39001');
    expect(content).toContain('kind:39002');
    // Message event kinds (word-boundary to avoid matching kind:9000 etc.)
    expect(content).toMatch(/kind:9\b/);
    expect(content).toMatch(/kind:11\b/);
  });

  it('[P0] nip-spec.md covers h tag format and usage', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    expect(content).toMatch(/\["h"/);
    expect(content.toLowerCase()).toMatch(/group.?id|group id/);
  });

  it('[P0] nip-spec.md covers d tag for group state events', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    expect(content).toMatch(/\["d"/);
    // d tag used for replaceable group state events (kind:39000-39002)
    expect(content.toLowerCase()).toMatch(
      /d.*tag.*group|group.*d.*tag|`d` tag/
    );
  });

  it('[P0] nip-spec.md covers code tag for group invites (kind:9009)', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    expect(content).toMatch(/\["code"/);
    expect(content.toLowerCase()).toMatch(/invite/);
  });

  it('[P0] nip-spec.md covers permissions model', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toContain('add-user');
    expect(lower).toContain('edit-metadata');
    expect(lower).toContain('delete-event');
    expect(lower).toContain('remove-user');
    expect(lower).toContain('add-permission');
    expect(lower).toContain('remove-permission');
    expect(lower).toContain('edit-group-status');
  });
});

// ─── AC3: TOON Write Model [Test: TOON-A, TOON-B] ──────────────────────

describe('[TOON-A, TOON-B] AC3: TOON Write Model', () => {
  it('[P0] SKILL.md body references publishEvent() for group messages', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/publishEvent\(\)/);
  });

  it('[P0] SKILL.md body references @toon-protocol/client', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/@toon-protocol\/client/);
  });

  it('[P0] SKILL.md body explains h tag requirement for group messages', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    // h tag must be mentioned in context of group message publishing
    expect(lower).toMatch(/h.*tag/);
    expect(lower).toMatch(/group.*id|group id/);
  });

  it('[P0] SKILL.md body explains per-byte cost for group messages', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/per.?byte|basepriceperbyte/);
    expect(lower).toMatch(/cost|fee|price/);
  });

  it('[P0] SKILL.md body explains admin actions (kind:9000-9009) cost per-byte', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    // Must mention admin actions having cost
    expect(lower).toMatch(/admin.*cost|admin.*per.?byte|admin.*economic/);
  });

  it('[P0] SKILL.md body explains ILP-gated group entry', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/ilp/);
    expect(lower).toMatch(/gat(ed|ing)|payment.*channel/);
  });

  it('[P0] SKILL.md body explains dual-barrier model (social + economic)', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/dual.?barrier|social.*economic|economic.*social/);
  });

  it('[P0] SKILL.md body references nostr-protocol-core for fee formula', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/nostr-protocol-core/);
    expect(body).toMatch(/toon-protocol-context/);
  });

  it('[P0] toon-extensions.md covers publishEvent flow for group messages', () => {
    const content = readFileSync(join(REFS_DIR, 'toon-extensions.md'), 'utf-8');
    expect(content).toMatch(/publishEvent/);
    expect(content).toMatch(/@toon-protocol\/client/);
  });

  it('[P0] toon-extensions.md covers admin action publishing flow', () => {
    const content = readFileSync(join(REFS_DIR, 'toon-extensions.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/admin/);
    expect(lower).toMatch(/kind:900[0-9]/);
    expect(lower).toMatch(/permission/);
  });

  it('[P0] toon-extensions.md covers ILP-gated group entry', () => {
    const content = readFileSync(join(REFS_DIR, 'toon-extensions.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/ilp/);
    expect(lower).toMatch(/gat(ed|ing)|payment/);
  });

  it('[P0] scenarios.md covers group participation scenarios', () => {
    const content = readFileSync(join(REFS_DIR, 'scenarios.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/join.*group|joining.*group/);
    expect(lower).toMatch(/post.*message|posting.*message/);
    expect(lower).toMatch(/kind:9/);
    expect(lower).toMatch(/publishevent/);
  });
});

// ─── AC4: TOON Read Model [Test: TOON-C] ────────────────────────────────

describe('[TOON-C] AC4: TOON Read Model', () => {
  it('[P0] SKILL.md body documents TOON-format strings (not JSON)', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/toon.?format/);
    expect(lower).toMatch(/not.*json|not standard json/);
  });

  it('[P0] SKILL.md body references nostr-protocol-core for TOON format parsing', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/nostr-protocol-core/);
  });

  it('[P0] SKILL.md body explains h tag filter for group subscriptions', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(
      /h.*tag.*filter|filter.*h.*tag|subscribe.*h.*tag|h.*tag.*subscri/
    );
  });

  it('[P0] SKILL.md body explains replaceable events for group state', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/replaceable/);
    expect(lower).toMatch(/kind:39000|kind:39001|kind:39002/);
  });

  it('[P0] SKILL.md body explains d tag for group state subscriptions', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    // Group state events (kind:39000-39002) use d tag, not h tag, for filtering
    expect(body).toMatch(/`d` tag|d tag|\["d"/);
  });

  it('[P0] SKILL.md body explains reading is free on TOON', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/read.*free|free.*read|reading.*free/);
  });
});

// ─── AC5: Social Context [Test: STRUCT-D, TOON-D] ───────────────────────

describe('[STRUCT-D, TOON-D] AC5: Social Context', () => {
  it('[P0] SKILL.md body contains ## Social Context section', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/## Social Context/);
  });

  it('[P0] Social Context covers group culture and observation before participation', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const socialSection = body.split('## Social Context')[1] || '';
    const lower = socialSection.toLowerCase();
    expect(lower).toMatch(/culture|norms/);
    expect(lower).toMatch(/observ|lurk/);
  });

  it('[P0] Social Context covers economic dynamics of per-message costs', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const socialSection = body.split('## Social Context')[1] || '';
    const lower = socialSection.toLowerCase();
    expect(lower).toMatch(/cost|money|paid|per.?byte/);
    expect(lower).toMatch(/quality|spam|hesitanc/);
  });

  it('[P0] Social Context covers admin action weight (cost + impact)', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const socialSection = body.split('## Social Context')[1] || '';
    const lower = socialSection.toLowerCase();
    expect(lower).toMatch(/admin/);
    expect(lower).toMatch(/weight|deliberate|cost/);
    expect(lower).toMatch(/kind:9001|kind:9005|remov|delet/);
  });

  it('[P0] Social Context covers reaction intimacy in groups', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const socialSection = body.split('## Social Context')[1] || '';
    const lower = socialSection.toLowerCase();
    expect(lower).toMatch(/reaction/);
    expect(lower).toMatch(/kind:7/);
    expect(lower).toMatch(/personal|intimate|direct|smaller/);
  });

  it('[P0] Social Context covers closed groups with ILP-gated entry', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const socialSection = body.split('## Social Context')[1] || '';
    const lower = socialSection.toLowerCase();
    expect(lower).toMatch(/closed/);
    expect(lower).toMatch(/ilp|economic|investment/);
    expect(lower).toMatch(/trust|high.?trust/);
  });

  it('[P0] Social Context covers relay-specific norms', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const socialSection = body.split('## Social Context')[1] || '';
    const lower = socialSection.toLowerCase();
    expect(lower).toMatch(/relay.*rule|relay.*norm|different.*relay/);
  });

  it('[P1] Social Context passes substitution test (NIP-specific, not generic)', () => {
    // The Social Context section should not make sense if "group" were replaced
    // with a generic term. Check it contains group-specific terminology.
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const socialSection = body.split('## Social Context')[1] || '';
    const lower = socialSection.toLowerCase();
    // Must contain group-specific terms, not just generic social advice
    expect(lower).toMatch(/group/);
    expect(lower).toMatch(/h tag|kind:7|kind:9001|kind:9005/);
  });
});

// ─── AC6: Eval Suite [Test: EVAL-A, EVAL-B] ─────────────────────────────

describe('[EVAL-A] AC6: Trigger Evals', () => {
  it('[P0] evals.json is valid JSON with required top-level keys', () => {
    const content = readFileSync(EVALS_JSON, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed).toBeDefined();
    expect(parsed).toHaveProperty('trigger_evals');
    expect(parsed).toHaveProperty('output_evals');
    expect(Array.isArray(parsed.trigger_evals)).toBe(true);
    expect(Array.isArray(parsed.output_evals)).toBe(true);
  });

  it('[P0] trigger_evals has 8-10 should-trigger queries', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const shouldTrigger = evals.trigger_evals.filter(
      (e: { should_trigger: boolean }) => e.should_trigger === true
    );
    expect(shouldTrigger.length).toBeGreaterThanOrEqual(8);
    expect(shouldTrigger.length).toBeLessThanOrEqual(10);
  });

  it('[P0] trigger_evals has 8-10 should-not-trigger queries', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const shouldNotTrigger = evals.trigger_evals.filter(
      (e: { should_trigger: boolean }) => e.should_trigger === false
    );
    expect(shouldNotTrigger.length).toBeGreaterThanOrEqual(8);
    expect(shouldNotTrigger.length).toBeLessThanOrEqual(10);
  });

  it('[P0] should-trigger queries cover protocol triggers', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const shouldTrigger = evals.trigger_evals
      .filter((e: { should_trigger: boolean }) => e.should_trigger === true)
      .map((e: { query: string }) => e.query.toLowerCase());
    const joined = shouldTrigger.join(' ');
    // Must cover key protocol triggers
    expect(joined).toMatch(/group/);
    expect(joined).toMatch(/nip.?29|relay/);
    expect(joined).toMatch(/h tag|kind:9|kind:11|admin|member/);
  });

  it('[P0] should-trigger queries cover social-situation triggers', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const shouldTrigger = evals.trigger_evals
      .filter((e: { should_trigger: boolean }) => e.should_trigger === true)
      .map((e: { query: string }) => e.query.toLowerCase());
    const joined = shouldTrigger.join(' ');
    expect(joined).toMatch(/how do i.*join|how do i.*post|how do i.*create/);
  });

  it('[P0] should-not-trigger queries exclude related-but-different topics', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const shouldNotTrigger = evals.trigger_evals
      .filter((e: { should_trigger: boolean }) => e.should_trigger === false)
      .map((e: { query: string }) => e.query.toLowerCase());
    const joined = shouldNotTrigger.join(' ');
    // Must exclude topics like profiles, long-form, reactions, DMs
    expect(joined).toMatch(
      /profile|long.?form|article|reaction|encrypt|follow/
    );
  });

  it('[P0] should-not-trigger specifically excludes moderated communities (NIP-72)', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const shouldNotTrigger = evals.trigger_evals
      .filter((e: { should_trigger: boolean }) => e.should_trigger === false)
      .map((e: { query: string }) => e.query.toLowerCase());
    const joined = shouldNotTrigger.join(' ');
    expect(joined).toMatch(/moderated communit|nip.?72/);
  });

  it('[P0] each trigger eval has query and should_trigger fields', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    for (const te of evals.trigger_evals) {
      expect(te).toHaveProperty('query');
      expect(te).toHaveProperty('should_trigger');
      expect(typeof te.query).toBe('string');
      expect(typeof te.should_trigger).toBe('boolean');
    }
  });
});

describe('[EVAL-B] AC6: Output Evals', () => {
  it('[P0] output_evals has 4-6 output evals', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    expect(evals.output_evals.length).toBeGreaterThanOrEqual(4);
    expect(evals.output_evals.length).toBeLessThanOrEqual(6);
  });

  it('[P0] each output eval has required fields (id, prompt, expected_output, rubric, assertions)', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    for (const oe of evals.output_evals) {
      expect(oe).toHaveProperty('id');
      expect(oe).toHaveProperty('prompt');
      expect(oe).toHaveProperty('expected_output');
      expect(oe).toHaveProperty('rubric');
      expect(oe).toHaveProperty('assertions');
      expect(typeof oe.id).toBe('string');
      expect(typeof oe.prompt).toBe('string');
      expect(typeof oe.expected_output).toBe('string');
      expect(typeof oe.rubric).toBe('object');
      expect(Array.isArray(oe.assertions)).toBe(true);
    }
  });

  it('[P0] each output eval rubric has correct/acceptable/incorrect', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    for (const oe of evals.output_evals) {
      expect(oe.rubric).toHaveProperty('correct');
      expect(oe.rubric).toHaveProperty('acceptable');
      expect(oe.rubric).toHaveProperty('incorrect');
    }
  });

  it('[P0] output evals include h tag assertion', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const allAssertions = evals.output_evals
      .flatMap((oe: { assertions: string[] }) => oe.assertions)
      .join(' ')
      .toLowerCase();
    expect(allAssertions).toMatch(/h tag/);
  });

  it('[P0] output evals include relay-as-authority assertion', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const allAssertions = evals.output_evals
      .flatMap((oe: { assertions: string[] }) => oe.assertions)
      .join(' ')
      .toLowerCase();
    expect(allAssertions).toMatch(
      /relay.*authority|authority.*relay|store.?and.?forward/
    );
  });

  it('[P0] output evals include fee awareness assertion', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const allAssertions = evals.output_evals
      .flatMap((oe: { assertions: string[] }) => oe.assertions)
      .join(' ')
      .toLowerCase();
    expect(allAssertions).toMatch(/fee|cost|byte/);
  });
});

// ─── AC7: TOON Compliance [Test: TOON-A through TOON-D] ────────────────

describe('[TOON-A] AC7: toon-write-check', () => {
  it('[P0] skill uses publishEvent(), no bare ["EVENT", ...] patterns', () => {
    const allContent = readAllSkillContent();
    expect(allContent).toMatch(/publishEvent/);
    // Check for banned patterns - bare EVENT array patterns
    const bareEventPattern = /\["EVENT"\s*,/;
    expect(allContent).not.toMatch(bareEventPattern);
  });
});

describe('[TOON-B] AC7: toon-fee-check', () => {
  it('[P0] skill includes fee awareness for group messages', () => {
    const allContent = readAllSkillContent().toLowerCase();
    expect(allContent).toMatch(/per.?byte|basepriceperbyte/);
    expect(allContent).toMatch(/cost|fee|pric/);
  });

  it('[P0] skill includes fee awareness for admin actions', () => {
    const allContent = readAllSkillContent().toLowerCase();
    // Admin actions should also mention cost
    expect(allContent).toMatch(
      /admin.*cost|admin.*per.?byte|admin.*fee|moderation.*cost/
    );
  });
});

describe('[TOON-C] AC7: toon-format-check', () => {
  it('[P0] skill documents TOON-format strings (read-capable skill)', () => {
    const allContent = readAllSkillContent().toLowerCase();
    expect(allContent).toMatch(/toon.?format/);
    expect(allContent).toMatch(/not.*json|not standard json/);
  });
});

describe('[TOON-D] AC7: social-context-check', () => {
  it('[P0] has group-specific Social Context section (not generic)', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/## Social Context/);
    const socialSection = body.split('## Social Context')[1] || '';
    const lower = socialSection.toLowerCase();
    // Must be group-specific
    expect(lower).toMatch(/group/);
    expect(lower).toMatch(/kind:7.*h.*tag|h.*tag.*kind:7|reaction.*group/);
  });
});

describe('[TOON-A/B] AC7: trigger-coverage', () => {
  it('[P0] description includes both protocol and social-situation triggers', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    // Protocol triggers
    expect(desc).toMatch(/nip.?29/);
    expect(desc).toMatch(/kind:9\b/);
    expect(desc).toMatch(/kind:11/);
    expect(desc).toMatch(/h tag/);
    // Social-situation triggers
    expect(desc).toMatch(/how do i|how do.*group|how does/);
  });
});

describe('AC7: eval-completeness', () => {
  it('[P0] at least 6 trigger evals + 4 output evals', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    expect(evals.trigger_evals.length).toBeGreaterThanOrEqual(6);
    expect(evals.output_evals.length).toBeGreaterThanOrEqual(4);
  });
});

// ─── AC8: Description Optimization [Test: STRUCT-B] ─────────────────────

describe('[STRUCT-B] AC8: Description Optimization', () => {
  it('[P1] description is between 80-120 words', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const wc = wordCount(frontmatter.description as string);
    expect(wc).toBeGreaterThanOrEqual(80);
    expect(wc).toBeLessThanOrEqual(120);
  });

  it('[P0] description includes NIP-29 trigger', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    expect(desc).toMatch(/nip.?29/);
  });

  it('[P0] description includes relay groups trigger', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    expect(desc).toMatch(/relay.*group|group.*relay/);
  });

  it('[P0] description includes group chat trigger', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    expect(desc).toMatch(/group.*chat|chat.*group/);
  });

  it('[P0] description includes group membership trigger', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    expect(desc).toMatch(/member/);
  });

  it('[P0] description includes h tag trigger', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    expect(desc).toMatch(/h tag/);
  });

  it('[P0] description includes kind:9 and kind:11 triggers', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = frontmatter.description as string;
    expect(desc).toMatch(/kind:9\b/);
    expect(desc).toMatch(/kind:11/);
  });

  it('[P0] description includes group admin trigger', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    expect(desc).toMatch(/group.*admin|admin.*action|admin.*group/);
  });

  it('[P0] description includes group moderation trigger', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    expect(desc).toMatch(/moderation|moderate/);
  });

  it('[P0] description includes create group trigger', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    expect(desc).toMatch(/create.*group|group.*creat/);
  });

  it('[P0] description includes group invite trigger', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    expect(desc).toMatch(/invite/);
  });

  it('[P0] description includes group permissions trigger', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    expect(desc).toMatch(/permission/);
  });

  it('[P0] description includes closed group trigger', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    expect(desc).toMatch(/closed.*group|open.*closed/);
  });

  it('[P0] description includes social-situation triggers', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    // Must include "how do I" style social-situation triggers
    expect(desc).toMatch(/how do/);
  });
});

// ─── AC9: Token Budget [Test: STRUCT-C] ──────────────────────────────────

describe('[STRUCT-C] AC9: Token Budget', () => {
  it('[P1] SKILL.md body is under 500 lines', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lineCount = body.split('\n').length;
    expect(lineCount).toBeLessThan(500);
  });

  it('[P1] SKILL.md body is approximately 5k tokens or fewer (under 150 lines as proxy)', () => {
    // ~5k tokens at ~35 tokens/line is roughly 143 lines
    // Use 150 as a conservative proxy
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lineCount = body.split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(150);
  });
});

// ─── AC10: Dependency References [Test: DEP-A] ──────────────────────────

describe('[DEP-A] AC10: Dependency References', () => {
  it('[P1] SKILL.md references nostr-protocol-core (Story 9.1)', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/nostr-protocol-core/);
  });

  it('[P1] SKILL.md references nostr-social-intelligence (Story 9.0)', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/nostr-social-intelligence/);
  });

  it('[P1] SKILL.md references social-interactions (Story 9.6) for group-scoped reactions', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/social-interactions/);
  });

  it('[P1] SKILL.md references content-references (Story 9.7) for URI embedding', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/content-references/);
  });

  it('[P1] SKILL.md does NOT duplicate toon-protocol-context.md into references/', () => {
    // Per D9-010, the canonical protocol context lives in nostr-protocol-core
    const refFiles = readdirSync(REFS_DIR);
    expect(refFiles).not.toContain('toon-protocol-context.md');
  });
});

// ─── AC11: With/Without Baseline [Test: BASE-A] ─────────────────────────

describe('[BASE-A] AC11: With/Without Baseline', () => {
  it('[P1] SKILL.md body provides actionable group participation guidance (not just NIP summary)', () => {
    // Proxy for with/without: the skill should contain TOON-specific guidance
    // that an agent without the skill would not know
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    // Must contain TOON-specific guidance that adds value over base knowledge
    expect(lower).toMatch(/publishevent/);
    expect(lower).toMatch(/per.?byte/);
    expect(lower).toMatch(/ilp/);
    expect(lower).toMatch(/toon.?format/);
    // Must contain group-specific social guidance
    expect(lower).toMatch(/observ|lurk/);
    expect(lower).toMatch(/quality.*filter|economic.*weight|economic.*barrier/);
  });

  it('[P1] scenarios.md provides step-by-step TOON flows (not just kind descriptions)', () => {
    const content = readFileSync(join(REFS_DIR, 'scenarios.md'), 'utf-8');
    const lower = content.toLowerCase();
    // Must have actionable step-by-step flows
    expect(lower).toMatch(/step|steps/);
    expect(lower).toMatch(/publishevent/);
    expect(lower).toMatch(/fee|cost|price/);
  });
});

// ─── Cross-cutting: Writing Style ───────────────────────────────────────

describe('Writing Style Compliance', () => {
  it('[P1] SKILL.md body uses imperative/infinitive form (no "you should")', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const youShouldCount = (body.match(/\byou should\b/gi) || []).length;
    expect(youShouldCount).toBe(0);
  });

  it('[P1] SKILL.md body contains "When to read each reference" guidance', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body.toLowerCase()).toMatch(
      /when to (read|load|consult) each reference/i
    );
  });

  it('[P0] reference files explain WHY (reasoning, not just rules)', () => {
    // Per D9-008: reference files should explain reasoning
    for (const ref of EXPECTED_REFS) {
      const content = readFileSync(join(REFS_DIR, ref), 'utf-8');
      const lower = content.toLowerCase();
      expect(lower).toMatch(/why|because|reason|this means|this matter/);
    }
  });
});

// ─── Cross-cutting: h Tag Consistency ───────────────────────────────────

describe('h Tag Cross-File Consistency', () => {
  it('[P0] h tag is documented consistently across SKILL.md and nip-spec.md', () => {
    const skillContent = readFileSync(SKILL_MD, 'utf-8');
    const nipSpec = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    // Both should reference the h tag format
    expect(skillContent).toMatch(/\["h"/);
    expect(nipSpec).toMatch(/\["h"/);
  });

  it('[P0] h tag is mentioned in scenarios.md for group operations', () => {
    const content = readFileSync(join(REFS_DIR, 'scenarios.md'), 'utf-8');
    expect(content).toMatch(/h.*tag|\["h"/i);
  });

  it('[P0] h tag is mentioned in toon-extensions.md for publishing flow', () => {
    const content = readFileSync(join(REFS_DIR, 'toon-extensions.md'), 'utf-8');
    expect(content).toMatch(/h.*tag|\["h"/i);
  });

  it('[P0] scenarios.md distinguishes d tag (state) from h tag (messages) in subscription scenario', () => {
    const content = readFileSync(join(REFS_DIR, 'scenarios.md'), 'utf-8');
    // Subscription scenario should mention both d and h tag filtering
    expect(content).toMatch(/#d/);
    expect(content).toMatch(/#h/);
  });
});

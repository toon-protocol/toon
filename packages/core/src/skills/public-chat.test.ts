/**
 * ATDD: Story 9.10 — Public Chat Skill (public-chat)
 *
 * Structural validation tests for the public-chat Claude Agent Skill.
 * This story produces markdown + JSON files, NOT TypeScript code.
 * Tests validate file existence, format compliance, content coverage, eval structure,
 * TOON compliance, dependency references, and social context appropriateness.
 *
 * Classification: "both" (read + write). NIP-28 public chat channels.
 *
 * Test IDs from test-design-epic-9.md Standard Skill Validation Template:
 *   STRUCT-A, STRUCT-B, STRUCT-C, STRUCT-D
 *   EVAL-A, EVAL-B
 *   TOON-A, TOON-B, TOON-C, TOON-D
 *   BASE-A
 *   DEP-A
 *
 * @see _bmad-output/implementation-artifacts/9-10-public-chat-skill.md
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve, join } from 'path';
import { parse as parseYaml } from 'yaml';

// Resolve project root (vitest runs from repo root)
const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const SKILL_DIR = join(PROJECT_ROOT, '.claude', 'skills', 'public-chat');
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
  it('[P0] SKILL.md exists at .claude/skills/public-chat/SKILL.md', () => {
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
    expect(frontmatter).toHaveProperty('name', 'public-chat');
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

describe('[EVAL-A, EVAL-B] AC2: NIP-28 Coverage', () => {
  it('[P0] SKILL.md body covers NIP-28 public chat model', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toContain('nip-28');
    expect(lower).toContain('public chat');
    expect(lower).toContain('channel');
  });

  it('[P0] SKILL.md body covers channel creation (kind:40) with JSON content', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/kind:40/);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/channel.*creat|creat.*channel/);
    expect(lower).toMatch(/json/);
    expect(lower).toMatch(/name/);
    expect(lower).toMatch(/about/);
    expect(lower).toMatch(/picture/);
  });

  it('[P0] SKILL.md body covers channel metadata updates (kind:41)', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/kind:41/);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/metadata/);
    expect(lower).toMatch(/update/);
  });

  it('[P0] SKILL.md body covers channel messages (kind:42) with e tag root marker', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/kind:42/);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/message/);
    expect(lower).toMatch(/root/);
    expect(body).toMatch(/e.*tag|"e"/);
  });

  it('[P0] SKILL.md body covers hide message (kind:43)', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/kind:43/);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/hide/);
  });

  it('[P0] SKILL.md body covers mute user (kind:44)', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/kind:44/);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/mute/);
  });

  it('[P0] SKILL.md body covers reply marker for message replies', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/reply/);
    expect(lower).toMatch(/reply.*marker|replied.*to/);
    expect(body).toMatch(/reply/);
  });

  it('[P0] SKILL.md body covers p tag for replied-to user', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/p.*tag|"p"|`p`/);
  });

  it('[P0] SKILL.md body covers channel discovery via kind:40 subscriptions', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/discover|subscribe.*kind:40|kind:40.*subscri/);
  });

  it('[P0] SKILL.md body covers metadata authorization (kind:41 author = kind:40 creator)', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/creator|author.*match|only.*creator/);
  });

  it('[P0] nip-spec.md covers all five NIP-28 event kinds (40-44)', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    expect(content).toContain('kind:40');
    expect(content).toContain('kind:41');
    expect(content).toContain('kind:42');
    expect(content).toContain('kind:43');
    expect(content).toContain('kind:44');
  });

  it('[P0] nip-spec.md covers e tag root marker for channel messages', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/root.*marker|"root"/);
    expect(content).toMatch(/\["e"/);
  });

  it('[P0] nip-spec.md covers reply marker for message threading', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/reply.*marker|"reply"/);
  });

  it('[P0] nip-spec.md covers p tag for replied-to user in kind:42', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    expect(content).toMatch(/\["p"/);
    const lower = content.toLowerCase();
    expect(lower).toMatch(/replied.?to|reply/);
  });

  it('[P0] nip-spec.md covers JSON content format for channel creation (name, about, picture)', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toContain('json');
    expect(lower).toContain('name');
    expect(lower).toContain('about');
    expect(lower).toContain('picture');
  });

  it('[P0] nip-spec.md covers optional reason in hide message (kind:43)', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/reason/);
    expect(lower).toMatch(/kind:43|hide/);
    expect(lower).toMatch(/optional/);
  });

  it('[P0] nip-spec.md covers optional reason in mute user (kind:44)', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/reason/);
    expect(lower).toMatch(/kind:44|mute/);
    expect(lower).toMatch(/optional/);
  });

  it('[P0] nip-spec.md covers kind:41 author must match kind:40 creator', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(
      /author.*match|creator.*only|only.*creator|non.?creator/
    );
  });

  it('[P0] nip-spec.md covers channel discovery filters', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/discover/);
    expect(lower).toMatch(/kinds.*\[40\]|kinds: \[40\]/);
    expect(lower).toMatch(/#e/);
  });

  it('[P0] nip-spec.md distinguishes NIP-28 from NIP-29 and NIP-72', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    expect(content).toMatch(/NIP-29/);
    expect(content).toMatch(/NIP-72/);
  });
});

// ─── AC3: TOON Write Model [Test: TOON-A, TOON-B] ──────────────────────

describe('[TOON-A, TOON-B] AC3: TOON Write Model', () => {
  it('[P0] SKILL.md body references publishEvent() for chat events', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/publishEvent\(\)/);
  });

  it('[P0] SKILL.md body references @toon-protocol/client', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/@toon-protocol\/client/);
  });

  it('[P0] SKILL.md body explains per-byte cost for channel messages (kind:42)', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/per.?byte|basepriceperbyte/);
    expect(lower).toMatch(/cost|fee|price/);
    expect(lower).toMatch(/message/);
  });

  it('[P0] SKILL.md body explains channel creation (kind:40) costs per-byte', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/channel.*creat.*cost|creat.*cost|kind:40.*cost/);
  });

  it('[P0] SKILL.md body explains moderation actions (kind:43/44) cost per-byte', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(
      /moderat.*cost|kind:43.*cost|kind:44.*cost|hide.*cost|mute.*cost/
    );
  });

  it('[P0] SKILL.md body explains conciseness incentive from per-byte pricing', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(
      /conciseness.*incentive|concise.*incent|natural.*concis/
    );
  });

  it('[P0] SKILL.md body references nostr-protocol-core for fee formula', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/nostr-protocol-core/);
    expect(body).toMatch(/toon-protocol-context/);
  });

  it('[P0] toon-extensions.md covers publishEvent flow for channel messages', () => {
    const content = readFileSync(join(REFS_DIR, 'toon-extensions.md'), 'utf-8');
    expect(content).toMatch(/publishEvent/);
    expect(content).toMatch(/@toon-protocol\/client/);
  });

  it('[P0] toon-extensions.md covers channel creation publishing flow', () => {
    const content = readFileSync(join(REFS_DIR, 'toon-extensions.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/kind:40/);
    expect(lower).toMatch(/publishevent/);
  });

  it('[P0] toon-extensions.md covers moderation action publishing flow', () => {
    const content = readFileSync(join(REFS_DIR, 'toon-extensions.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/kind:43|kind:44|moderat/);
    expect(lower).toMatch(/publishevent/);
  });

  it('[P0] toon-extensions.md covers conciseness incentive', () => {
    const content = readFileSync(join(REFS_DIR, 'toon-extensions.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/conciseness|concise/);
    expect(lower).toMatch(/incentive|incent/);
  });

  it('[P0] toon-extensions.md covers spam resistance from per-byte pricing', () => {
    const content = readFileSync(join(REFS_DIR, 'toon-extensions.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/spam.*resist|spam.*unfeasible|spam.*economic/);
  });

  it('[P0] toon-extensions.md covers byte cost tables for all event kinds', () => {
    const content = readFileSync(join(REFS_DIR, 'toon-extensions.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/kind:42/);
    expect(lower).toMatch(/kind:40/);
    expect(lower).toMatch(/kind:41/);
    expect(lower).toMatch(/kind:43/);
    expect(lower).toMatch(/kind:44/);
    expect(lower).toMatch(/bytes/);
  });

  it('[P0] scenarios.md covers chat participation scenarios with publishEvent', () => {
    const content = readFileSync(join(REFS_DIR, 'scenarios.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/creat.*channel|channel.*creat/);
    expect(lower).toMatch(/send.*message|message.*channel/);
    expect(lower).toMatch(/kind:42/);
    expect(lower).toMatch(/publishevent/);
  });

  it('[P0] scenarios.md covers all seven scenarios', () => {
    const content = readFileSync(join(REFS_DIR, 'scenarios.md'), 'utf-8');
    const lower = content.toLowerCase();
    // Scenario 1: Creating a channel
    expect(lower).toMatch(/scenario 1.*creat|creat.*channel/);
    // Scenario 2: Sending a message
    expect(lower).toMatch(/scenario 2.*message|send.*message/);
    // Scenario 3: Replying to a message
    expect(lower).toMatch(/scenario 3.*reply|reply.*message/);
    // Scenario 4: Updating metadata
    expect(lower).toMatch(/scenario 4.*metadata|updat.*metadata/);
    // Scenario 5: Hiding a message
    expect(lower).toMatch(/scenario 5.*hid|hid.*message/);
    // Scenario 6: Muting a user
    expect(lower).toMatch(/scenario 6.*mut|mut.*user/);
    // Scenario 7: Discovering channels
    expect(lower).toMatch(/scenario 7.*discover|discover.*channel/);
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

  it('[P0] SKILL.md body explains subscribing to kind:40 for channel discovery', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(
      /subscribe.*kind:40|kind:40.*discover|channel.*discover/
    );
  });

  it('[P0] SKILL.md body explains subscribing to messages via #e tag filter', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/#e.*tag.*filter|#e.*filter|e.*tag.*filter/);
  });

  it('[P0] SKILL.md body explains validating kind:41 metadata against channel creator', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(
      /validate.*kind:41.*author|kind:41.*metadata.*creator|metadata.*author|author.*kind:40/
    );
  });

  it('[P0] SKILL.md body explains reading is free on TOON', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/read.*free|free.*read|reading.*free/);
  });

  it('[P0] toon-extensions.md covers TOON-format parsing for chat events', () => {
    const content = readFileSync(join(REFS_DIR, 'toon-extensions.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/toon.?format/);
    expect(lower).toMatch(/decode/);
  });

  it('[P0] toon-extensions.md states reading is free', () => {
    const content = readFileSync(join(REFS_DIR, 'toon-extensions.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/read.*free|free.*read/);
  });

  it('[P0] scenarios.md covers channel discovery with TOON-format decoding', () => {
    const content = readFileSync(join(REFS_DIR, 'scenarios.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/discover/);
    expect(lower).toMatch(/toon.?format|toon decoder/);
    expect(lower).toMatch(/kinds.*\[40\]|kinds: \[40\]/);
  });

  it('[P0] scenarios.md covers kind:41 metadata override validation', () => {
    const content = readFileSync(join(REFS_DIR, 'scenarios.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/kind:41/);
    expect(lower).toMatch(/creator|author.*match|non.?creator/);
  });
});

// ─── AC5: Social Context [Test: STRUCT-D, TOON-D] ───────────────────────

describe('[STRUCT-D, TOON-D] AC5: Social Context', () => {
  it('[P0] SKILL.md body contains ## Social Context section', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/## Social Context/);
  });

  it('[P0] Social Context has at least 100 words of chat-specific content', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const socialSection =
      body.split('## Social Context')[1]?.split(/\n## /)[0] || '';
    const wc = wordCount(socialSection);
    expect(wc).toBeGreaterThanOrEqual(100);
  });

  it('[P0] Social Context covers conciseness incentive from per-byte pricing', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const socialSection = body.split('## Social Context')[1] || '';
    const lower = socialSection.toLowerCase();
    expect(lower).toMatch(/concis/);
    expect(lower).toMatch(/per.?byte|cost|money/);
  });

  it('[P0] Social Context covers real-time conversational norms', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const socialSection = body.split('## Social Context')[1] || '';
    const lower = socialSection.toLowerCase();
    expect(lower).toMatch(/real.?time|conversational/);
    expect(lower).toMatch(/on.?topic|concise|flooding/);
  });

  it('[P0] Social Context covers channel purpose (read description before participating)', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const socialSection = body.split('## Social Context')[1] || '';
    const lower = socialSection.toLowerCase();
    expect(lower).toMatch(
      /description|about.*field|channel.*purpose|stated.*purpose/
    );
  });

  it('[P0] Social Context covers hide/mute as personal moderation tools', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const socialSection = body.split('## Social Context')[1] || '';
    const lower = socialSection.toLowerCase();
    expect(lower).toMatch(/personal.*moderat|hide.*mute|not.*global.*censor/);
  });

  it('[P0] Social Context distinguishes NIP-28 from NIP-29 relay groups', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const socialSection = body.split('## Social Context')[1] || '';
    const lower = socialSection.toLowerCase();
    expect(lower).toMatch(/nip-29|relay.*group|membership.*enforc/);
  });

  it('[P0] Social Context distinguishes NIP-28 from NIP-72 moderated communities', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const socialSection = body.split('## Social Context')[1] || '';
    const lower = socialSection.toLowerCase();
    expect(lower).toMatch(/nip-72|moderated.*communit|approval.*based/);
  });

  it('[P1] Social Context passes substitution test (chat-specific, not generic)', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const socialSection = body.split('## Social Context')[1] || '';
    const lower = socialSection.toLowerCase();
    // Must contain at least 5 chat-specific terms
    let specificTerms = 0;
    if (lower.match(/chat/)) specificTerms++;
    if (lower.match(/channel/)) specificTerms++;
    if (lower.match(/concis/)) specificTerms++;
    if (lower.match(/real.?time/)) specificTerms++;
    if (lower.match(/message/)) specificTerms++;
    if (lower.match(/hide|mute/)) specificTerms++;
    if (lower.match(/nip-29|relay.*group/)) specificTerms++;
    if (lower.match(/nip-72|communit/)) specificTerms++;
    expect(specificTerms).toBeGreaterThanOrEqual(5);
  });

  it('[P0] Social Context covers anti-patterns to avoid', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const socialSection = body.split('## Social Context')[1] || '';
    const lower = socialSection.toLowerCase();
    expect(lower).toMatch(/anti.?pattern|avoid/);
    expect(lower).toMatch(/rapid.?fire|combined|combine/);
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

  it('[P0] should-trigger queries cover protocol triggers (NIP-28, kind:40, kind:42, channel)', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const shouldTrigger = evals.trigger_evals
      .filter((e: { should_trigger: boolean }) => e.should_trigger === true)
      .map((e: { query: string }) => e.query.toLowerCase());
    const joined = shouldTrigger.join(' ');
    expect(joined).toMatch(/channel/);
    expect(joined).toMatch(/nip.?28|public.*chat/);
    expect(joined).toMatch(/kind:40|kind:42|kind:41|kind:43|kind:44/);
  });

  it('[P0] should-trigger queries cover social-situation triggers', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const shouldTrigger = evals.trigger_evals
      .filter((e: { should_trigger: boolean }) => e.should_trigger === true)
      .map((e: { query: string }) => e.query.toLowerCase());
    const joined = shouldTrigger.join(' ');
    expect(joined).toMatch(
      /how do i.*create|how do i.*send|how do i.*hide|how do i.*mute/
    );
  });

  it('[P0] should-trigger queries cover at least 5 of the 9 required chat-relevant terms', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const shouldTrigger = evals.trigger_evals
      .filter((e: { should_trigger: boolean }) => e.should_trigger === true)
      .map((e: { query: string }) => e.query.toLowerCase());
    const joined = shouldTrigger.join(' ');
    let found = 0;
    const terms = [
      /nip.?28/,
      /public.*chat/,
      /channel.*creat|kind:40/,
      /channel.*message|kind:42/,
      /hide.*message|kind:43/,
      /mute.*user|kind:44/,
      /channel.*metadata|kind:41/,
      /send.*message/,
      /chat.*channel/,
    ];
    for (const t of terms) {
      if (joined.match(t)) found++;
    }
    expect(found).toBeGreaterThanOrEqual(5);
  });

  it('[P0] should-not-trigger queries exclude related-but-different topics', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const shouldNotTrigger = evals.trigger_evals
      .filter((e: { should_trigger: boolean }) => e.should_trigger === false)
      .map((e: { query: string }) => e.query.toLowerCase());
    const joined = shouldNotTrigger.join(' ');
    expect(joined).toMatch(
      /profile|long.?form|article|reaction|encrypt|follow/
    );
  });

  it('[P0] should-not-trigger specifically excludes relay groups (NIP-29)', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const shouldNotTrigger = evals.trigger_evals
      .filter((e: { should_trigger: boolean }) => e.should_trigger === false)
      .map((e: { query: string }) => e.query.toLowerCase());
    const joined = shouldNotTrigger.join(' ');
    expect(joined).toMatch(/relay.*group|nip.?29/);
  });

  it('[P0] should-not-trigger specifically excludes moderated communities (NIP-72)', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const shouldNotTrigger = evals.trigger_evals
      .filter((e: { should_trigger: boolean }) => e.should_trigger === false)
      .map((e: { query: string }) => e.query.toLowerCase());
    const joined = shouldNotTrigger.join(' ');
    expect(joined).toMatch(/moderated communit|nip.?72|approve.*post/);
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

  it('[P0] output evals include e tag root marker assertion', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const allAssertions = evals.output_evals
      .flatMap((oe: { assertions: string[] }) => oe.assertions)
      .join(' ')
      .toLowerCase();
    expect(allAssertions).toMatch(/e tag|root marker/);
  });

  it('[P0] output evals include conciseness incentive assertion', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const allAssertions = evals.output_evals
      .flatMap((oe: { assertions: string[] }) => oe.assertions)
      .join(' ')
      .toLowerCase();
    expect(allAssertions).toMatch(/conciseness|concise/);
  });

  it('[P0] output evals include fee awareness assertion', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const allAssertions = evals.output_evals
      .flatMap((oe: { assertions: string[] }) => oe.assertions)
      .join(' ')
      .toLowerCase();
    expect(allAssertions).toMatch(/fee|cost|byte/);
  });

  it('[P0] output evals include three-way distinction assertion (NIP-28 vs NIP-29 vs NIP-72)', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const allAssertions = evals.output_evals
      .flatMap((oe: { assertions: string[] }) => oe.assertions)
      .join(' ')
      .toLowerCase();
    expect(allAssertions).toMatch(/nip-28|open chat/);
    expect(allAssertions).toMatch(/nip-29|relay.?enforc/);
    expect(allAssertions).toMatch(/nip-72|approval/);
  });

  it('[P0] output evals include toon-write-check assertion', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const allAssertions = evals.output_evals
      .flatMap((oe: { assertions: string[] }) => oe.assertions)
      .join(' ')
      .toLowerCase();
    expect(allAssertions).toMatch(/toon-write-check|publishevent/);
  });

  it('[P0] output evals include toon-format-check assertion', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const allAssertions = evals.output_evals
      .flatMap((oe: { assertions: string[] }) => oe.assertions)
      .join(' ')
      .toLowerCase();
    expect(allAssertions).toMatch(/toon-format-check|toon.?format/);
  });

  it('[P0] write-focused output evals have at least 5 assertions', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    // channel-creation and channel-message are write-focused evals
    const writeEvals = evals.output_evals.filter(
      (oe: { id: string }) =>
        oe.id === 'channel-creation' || oe.id === 'channel-message'
    );
    for (const we of writeEvals) {
      expect(we.assertions.length).toBeGreaterThanOrEqual(5);
    }
  });

  it('[P0] read-focused output evals have at least 3 assertions', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    // discover-channels is a read-focused eval
    const readEvals = evals.output_evals.filter(
      (oe: { id: string }) => oe.id === 'discover-channels'
    );
    for (const re of readEvals) {
      expect(re.assertions.length).toBeGreaterThanOrEqual(3);
    }
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
  it('[P0] skill includes fee awareness for channel messages', () => {
    const allContent = readAllSkillContent().toLowerCase();
    expect(allContent).toMatch(/per.?byte|basepriceperbyte/);
    expect(allContent).toMatch(/cost|fee|pric/);
  });

  it('[P0] skill includes fee awareness for channel creation', () => {
    const allContent = readAllSkillContent().toLowerCase();
    expect(allContent).toMatch(
      /channel.*creat.*cost|creat.*channel.*cost|kind:40.*cost|channel.*per.?byte/
    );
  });

  it('[P0] skill includes fee awareness for moderation actions', () => {
    const allContent = readAllSkillContent().toLowerCase();
    expect(allContent).toMatch(
      /moderat.*cost|hide.*cost|mute.*cost|kind:43.*cost|kind:44.*cost/
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
  it('[P0] has chat-specific Social Context section (not generic)', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/## Social Context/);
    const socialSection = body.split('## Social Context')[1] || '';
    const lower = socialSection.toLowerCase();
    // Must be chat-specific
    expect(lower).toMatch(/chat|channel/);
    expect(lower).toMatch(/concis|per.?byte|cost/);
  });
});

describe('[TOON-A/B] AC7: trigger-coverage', () => {
  it('[P0] description includes both protocol and social-situation triggers', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    // Protocol triggers
    expect(desc).toMatch(/nip.?28/);
    expect(desc).toMatch(/kind:40/);
    expect(desc).toMatch(/kind:42/);
    expect(desc).toMatch(/kind:43/);
    expect(desc).toMatch(/kind:44/);
    // Social-situation triggers
    expect(desc).toMatch(/how do i|how do.*channel|how does/);
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

  it('[P0] description includes NIP-28 trigger', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    expect(desc).toMatch(/nip.?28/);
  });

  it('[P0] description includes public chat trigger', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    expect(desc).toMatch(/public.*chat/);
  });

  it('[P0] description includes channel creation trigger (kind:40)', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    expect(desc).toMatch(/channel.*creat|creat.*channel|kind:40/);
  });

  it('[P0] description includes channel message trigger (kind:42)', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    expect(desc).toMatch(/channel.*message|kind:42/);
  });

  it('[P0] description includes hide message trigger (kind:43)', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    expect(desc).toMatch(/hide.*message|kind:43/);
  });

  it('[P0] description includes mute user trigger (kind:44)', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    expect(desc).toMatch(/mute.*user|kind:44/);
  });

  it('[P0] description includes channel metadata trigger (kind:41)', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    expect(desc).toMatch(/channel.*metadata|kind:41/);
  });

  it('[P0] description includes channel moderation trigger', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    expect(desc).toMatch(/moderation|moderate/);
  });

  it('[P0] description includes real-time chat trigger', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    expect(desc).toMatch(/real.?time.*chat|chat.*real.?time/);
  });

  it('[P0] description includes send message trigger', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    expect(desc).toMatch(/send.*message/);
  });

  it('[P0] description includes discover channels trigger', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    expect(desc).toMatch(/discover.*channel/);
  });

  it('[P0] description includes social-situation triggers', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    expect(desc).toMatch(/how do/);
  });

  it('[P1] description includes at least 2 chat-specific social-situation phrases', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    let found = 0;
    const phrases = [
      /how do i create a chat channel/,
      /how do i send a message to a channel/,
      /how do public chat channels work/,
      /how do i moderate a chat channel/,
      /how do i hide a message/,
      /how do i mute a user/,
      /how do i update channel metadata/,
    ];
    for (const p of phrases) {
      if (desc.match(p)) found++;
    }
    expect(found).toBeGreaterThanOrEqual(2);
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
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lineCount = body.split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(150);
  });

  it('[P1] SKILL.md body is under 3500 words (token proxy)', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const wc = wordCount(body);
    expect(wc).toBeLessThanOrEqual(3500);
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

  it('[P1] SKILL.md references social-interactions (Story 9.6) for chat-scoped reactions', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/social-interactions/);
  });

  it('[P1] SKILL.md references content-references (Story 9.7) for URI embedding', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/content-references/);
  });

  it('[P1] SKILL.md references relay-groups (Story 9.8) for distinguishing NIP-28 from NIP-29', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/relay-groups/);
  });

  it('[P1] SKILL.md references moderated-communities (Story 9.9) for distinguishing NIP-28 from NIP-72', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/moderated-communities/);
  });

  it('[P1] SKILL.md does NOT duplicate toon-protocol-context.md into references/', () => {
    const refFiles = readdirSync(REFS_DIR);
    expect(refFiles).not.toContain('toon-protocol-context.md');
  });

  it('[P1] all six upstream skill references are present', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const deps = [
      'nostr-protocol-core',
      'nostr-social-intelligence',
      'social-interactions',
      'content-references',
      'relay-groups',
      'moderated-communities',
    ];
    for (const dep of deps) {
      expect(body).toContain(dep);
    }
  });
});

// ─── AC11: With/Without Baseline [Test: BASE-A] ─────────────────────────

describe('[BASE-A] AC11: With/Without Baseline', () => {
  it('[P1] SKILL.md body provides actionable chat participation guidance (not just NIP summary)', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    // Must contain TOON-specific guidance that adds value over base knowledge
    expect(lower).toMatch(/publishevent/);
    expect(lower).toMatch(/per.?byte/);
    expect(lower).toMatch(/toon.?format/);
    // Must contain chat-specific social guidance
    expect(lower).toMatch(/concis/);
    expect(lower).toMatch(/channel.*purpose|about.*field|description.*before/);
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

  it('[P1] SKILL.md body contains "When to Read Each Reference" guidance', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body.toLowerCase()).toMatch(
      /when to (read|load|consult) each reference/i
    );
  });

  it('[P0] reference files explain WHY (reasoning, not just rules)', () => {
    for (const ref of EXPECTED_REFS) {
      const content = readFileSync(join(REFS_DIR, ref), 'utf-8');
      const lower = content.toLowerCase();
      expect(lower).toMatch(/why|because|reason|this means|this matter/);
    }
  });
});

// ─── Cross-cutting: e Tag Consistency ───────────────────────────────────

describe('e Tag Cross-File Consistency', () => {
  it('[P0] e tag with root marker is documented consistently across SKILL.md and nip-spec.md', () => {
    const skillContent = readFileSync(SKILL_MD, 'utf-8');
    const nipSpec = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    // Both should reference the e tag with root marker
    expect(skillContent).toMatch(/\["e"/);
    expect(nipSpec).toMatch(/\["e"/);
    expect(skillContent).toMatch(/root/);
    expect(nipSpec).toMatch(/root/);
  });

  it('[P0] e tag is mentioned in scenarios.md for channel operations', () => {
    const content = readFileSync(join(REFS_DIR, 'scenarios.md'), 'utf-8');
    expect(content).toMatch(/e.*tag|\["e"/i);
    expect(content.toLowerCase()).toMatch(/root/);
  });

  it('[P0] e tag is mentioned in toon-extensions.md for publishing flow', () => {
    const content = readFileSync(join(REFS_DIR, 'toon-extensions.md'), 'utf-8');
    expect(content).toMatch(/e.*tag|\["e"/i);
  });

  it('[P0] scenarios.md covers reply threading with both root and reply e tags', () => {
    const content = readFileSync(join(REFS_DIR, 'scenarios.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/root/);
    expect(lower).toMatch(/reply/);
    expect(content).toMatch(/\["e"/);
  });
});

// ─── Cross-cutting: Channel Identity Consistency ─────────────────────────

describe('Channel Identity Cross-File Consistency', () => {
  it('[P0] channel identity (kind:40 event ID) documented in SKILL.md', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(
      /kind:40.*event.*id|event.*id.*kind:40|channel.*identifier/
    );
  });

  it('[P0] channel identity documented in nip-spec.md', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(
      /kind:40.*event.*id|event.*id.*kind:40|channel.*identifier/
    );
  });

  it('[P0] channel identity referenced in scenarios.md', () => {
    const content = readFileSync(join(REFS_DIR, 'scenarios.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(
      /event.*id.*channel|channel.*identifier|permanent.*identifier/
    );
  });
});

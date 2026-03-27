/**
 * ATDD: Story 9.33 -- Relay Discovery Skill (relay-discovery)
 *
 * Structural validation tests for the relay-discovery Claude Agent Skill.
 * This story produces markdown + JSON files, NOT TypeScript code.
 * Tests validate file existence, format compliance, content coverage, eval structure,
 * TOON compliance, dependency references, and social context appropriateness.
 *
 * Classification: "read-focused" (NIP-11 HTTP + NIP-65 kind:10002 + NIP-66 monitoring).
 * Only kind:10002 is agent-writable; NIP-11 and NIP-66 are read/query operations.
 *
 * Test IDs from Standard Skill Validation Template:
 *   STRUCT-A, STRUCT-B, STRUCT-C, STRUCT-D
 *   EVAL-A, EVAL-B
 *   TOON-A, TOON-B, TOON-C, TOON-D
 *   BASE-A
 *   DEP-A
 *
 * @see _bmad-output/implementation-artifacts/9-33-relay-discovery-skill.md
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve, join } from 'path';
import { parse as parseYaml } from 'yaml';

// Resolve project root (vitest runs from repo root)
const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const SKILL_DIR = join(PROJECT_ROOT, '.claude', 'skills', 'relay-discovery');
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

// ─── AC1: Directory Layout [Test: STRUCT-A] ──────────────────────────────

describe('[STRUCT-A] AC1: Directory Layout', () => {
  it('[P0] SKILL.md exists at .claude/skills/relay-discovery/SKILL.md', () => {
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

// ─── AC1: Frontmatter Validity [Test: STRUCT-B] ─────────────────────────

describe('[STRUCT-B] AC1: Frontmatter Validity', () => {
  it('[P0] SKILL.md has valid YAML frontmatter with name and description', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter).toHaveProperty('name', 'relay-discovery');
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

// ─── AC2: NIP-11 Coverage ────────────────────────────────────────────────

describe('AC2: NIP-11 Relay Information Document Coverage', () => {
  it('[P0] SKILL.md body covers NIP-11 relay information document', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toContain('nip-11');
    expect(lower).toMatch(/relay information document|relay info/);
  });

  it('[P0] SKILL.md body covers TOON-enriched NIP-11 extensions: pricing', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/basepriceperbyte/);
    expect(lower).toMatch(/pricing/);
  });

  it('[P0] SKILL.md body covers TOON-enriched NIP-11 extensions: ILP capabilities', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/ilp/);
    expect(lower).toMatch(/ilpaddress|ilp.*address/);
  });

  it('[P0] SKILL.md body covers TOON-enriched NIP-11 extensions: chain config', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/chain.*config|chainid/);
  });

  it('[P0] SKILL.md body covers TOON-enriched NIP-11 extensions: x402 status', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/x402/);
  });

  it('[P0] SKILL.md body covers TOON-enriched NIP-11 extensions: TEE attestation', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/tee.*attestation|nitroattested|attestation.*status/);
  });

  it('[P0] SKILL.md body covers payment_required field in NIP-11 limitation object', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/payment_required/);
  });

  it('[P0] nip-spec.md covers NIP-11 HTTP GET with Accept: application/nostr+json header', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/http get/i);
    expect(content).toMatch(/application\/nostr\+json/);
  });

  it('[P0] nip-spec.md covers NIP-11 standard fields (name, description, pubkey, contact, supported_nips)', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toContain('supported_nips');
    expect(lower).toContain('pubkey');
    expect(lower).toContain('contact');
  });

  it('[P0] nip-spec.md covers NIP-11 limitation object fields', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/limitation/);
    expect(lower).toMatch(/max_message_length|max_content_length/);
    expect(lower).toMatch(/payment_required/);
    expect(lower).toMatch(/auth_required/);
  });

  it('[P0] nip-spec.md covers NIP-11 retention and relay_countries fields', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/retention/);
    expect(lower).toMatch(/relay_countries/);
  });
});

// ─── AC3: NIP-65 Relay List Metadata Coverage ────────────────────────────

describe('AC3: NIP-65 Relay List Metadata Coverage', () => {
  it('[P0] SKILL.md body covers NIP-65 kind:10002 relay list metadata', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toContain('nip-65');
    expect(body).toMatch(/kind:10002/);
    expect(lower).toMatch(/relay list/);
  });

  it('[P0] SKILL.md body covers read/write relay designations', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/read.*write|write.*read/);
    expect(lower).toMatch(/designation|marker/);
  });

  it('[P0] nip-spec.md covers NIP-65 kind:10002 event structure', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    expect(content).toMatch(/kind:10002/);
    const lower = content.toLowerCase();
    expect(lower).toMatch(/replaceable/);
  });

  it('[P0] nip-spec.md covers r tags with relay URL and optional read/write marker', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    expect(content).toMatch(/\["r"/);
    const lower = content.toLowerCase();
    expect(lower).toMatch(/read/);
    expect(lower).toMatch(/write/);
  });

  it('[P0] nip-spec.md documents kind:10002 has no content field', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/no content|empty content|content.*empty/);
  });
});

// ─── AC4: NIP-66 Relay Discovery and Liveness Coverage ───────────────────

describe('AC4: NIP-66 Relay Discovery and Liveness Coverage', () => {
  it('[P0] SKILL.md body covers NIP-66 relay discovery and liveness', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toContain('nip-66');
    expect(lower).toMatch(/relay discovery|relay.*liveness|relay monitor/);
  });

  it('[P0] SKILL.md body covers kind:10166 relay monitor announcements', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/kind:10166/);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/monitor.*announce|relay monitor/);
  });

  it('[P0] SKILL.md body covers kind:30166 relay meta', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/kind:30166/);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/relay meta/);
  });

  it('[P0] SKILL.md body covers kind:10066 relay list to monitor', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/kind:10066/);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/relay list.*monitor|monitor.*relay list/);
  });

  it('[P0] nip-spec.md covers all three NIP-66 event kinds (10166, 30166, 10066)', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    expect(content).toContain('kind:10166');
    expect(content).toContain('kind:30166');
    expect(content).toContain('kind:10066');
  });

  it('[P0] nip-spec.md covers kind:30166 d tag = relay URL', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/kind:30166/);
    expect(content).toMatch(/\["d"/);
    expect(lower).toMatch(/relay url/);
  });

  it('[P0] nip-spec.md covers kind:30166 rtt (round-trip time) tags', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/rtt/);
    expect(lower).toMatch(/round.?trip/);
  });

  it('[P0] nip-spec.md covers kind:10166 monitor announcement with t tags', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    expect(content).toMatch(/kind:10166/);
    expect(content).toMatch(/\["t"/);
  });

  it('[P0] nip-spec.md covers kind:10066 r tags with relay URLs to monitor', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/kind:10066/);
    expect(content).toMatch(/\["r"/);
  });

  it('[P0] nip-spec.md documents kind:30166 as parameterized replaceable', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/parameterized.*replaceable/);
  });
});

// ─── AC5: NIP Spec Reference File (nip-spec.md) ─────────────────────────

describe('AC5: nip-spec.md Consolidated Coverage', () => {
  it('[P0] nip-spec.md exists and covers all three NIPs (11, 65, 66)', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toContain('nip-11');
    expect(lower).toContain('nip-65');
    expect(lower).toContain('nip-66');
  });

  it('[P0] nip-spec.md documents relay information document HTTP structure', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/http/);
    expect(content).toMatch(/application\/nostr\+json/);
  });

  it('[P0] nip-spec.md documents relay list event structure (kind:10002)', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    expect(content).toMatch(/kind:10002/);
    expect(content).toMatch(/\["r"/);
  });

  it('[P0] nip-spec.md documents relay monitoring events (kind:10166, 30166, 10066)', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    expect(content).toContain('kind:10166');
    expect(content).toContain('kind:30166');
    expect(content).toContain('kind:10066');
  });

  it('[P0] nip-spec.md documents required vs optional fields for NIP-11', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/required|optional/);
  });

  it('[P0] nip-spec.md documents filter patterns for relay discovery events', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/filter/);
    expect(lower).toMatch(/kinds/);
  });
});

// ─── AC6: TOON Extensions Reference File (toon-extensions.md) ───────────

describe('AC6: toon-extensions.md Coverage', () => {
  it('[P0] toon-extensions.md covers enriched /health endpoint', () => {
    const content = readFileSync(join(REFS_DIR, 'toon-extensions.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/\/health/);
    expect(lower).toMatch(/enriched|extended|toon/);
  });

  it('[P0] toon-extensions.md covers pricing fields (basePricePerByte)', () => {
    const content = readFileSync(join(REFS_DIR, 'toon-extensions.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/basepriceperbyte/);
    expect(lower).toMatch(/pricing/);
  });

  it('[P0] toon-extensions.md covers ILP capabilities (ilpAddress, btpUrl)', () => {
    const content = readFileSync(join(REFS_DIR, 'toon-extensions.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/ilpaddress|ilp.*address/);
    expect(lower).toMatch(/btpurl|btp.*url/);
  });

  it('[P0] toon-extensions.md covers chain config (chainId, tokenNetworkAddress, usdcAddress)', () => {
    const content = readFileSync(join(REFS_DIR, 'toon-extensions.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/chainid/);
    expect(lower).toMatch(/tokennetworkaddress/);
    expect(lower).toMatch(/usdcaddress/);
  });

  it('[P0] toon-extensions.md covers x402 status', () => {
    const content = readFileSync(join(REFS_DIR, 'toon-extensions.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/x402/);
  });

  it('[P0] toon-extensions.md covers TEE attestation fields', () => {
    const content = readFileSync(join(REFS_DIR, 'toon-extensions.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/nitroattested/);
    expect(lower).toMatch(/enclaveid/);
    expect(lower).toMatch(/pcrs/);
  });

  it('[P0] toon-extensions.md covers seed relay discovery (kind:10036)', () => {
    const content = readFileSync(join(REFS_DIR, 'toon-extensions.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/kind:10036/);
    expect(lower).toMatch(/seed relay/);
  });

  it('[P0] toon-extensions.md covers ILP peer info (kind:10032)', () => {
    const content = readFileSync(join(REFS_DIR, 'toon-extensions.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/kind:10032/);
    expect(lower).toMatch(/ilp peer|peer info/);
  });

  it('[P0] toon-extensions.md documents read-focused nature (minimal write model)', () => {
    const content = readFileSync(join(REFS_DIR, 'toon-extensions.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/read.*focus|read.*free|free.*read/);
    expect(lower).toMatch(/kind:10002.*only|only.*kind:10002|minimal.*write/);
  });

  it('[P0] toon-extensions.md documents fee estimate for kind:10002 relay list', () => {
    const content = readFileSync(join(REFS_DIR, 'toon-extensions.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/kind:10002/);
    expect(lower).toMatch(/fee|cost|\$/);
  });

  it('[P0] toon-extensions.md documents relay evaluation criteria (pricing, TEE, ILP route)', () => {
    const content = readFileSync(join(REFS_DIR, 'toon-extensions.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/evaluation|evaluat|criteria/);
    expect(lower).toMatch(/pricing|price/);
    expect(lower).toMatch(/tee|attestation/);
  });
});

// ─── AC7: Scenarios Reference File (scenarios.md) ───────────────────────

describe('AC7: scenarios.md Coverage', () => {
  it('[P0] scenarios.md covers relay discovery on paid networks', () => {
    const content = readFileSync(join(REFS_DIR, 'scenarios.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/discover/);
    expect(lower).toMatch(/paid|ilp.?gated|cost|pricing/);
  });

  it('[P0] scenarios.md covers relay list management (publishing relay preferences)', () => {
    const content = readFileSync(join(REFS_DIR, 'scenarios.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/relay list/);
    expect(lower).toMatch(/publish|update/);
    expect(lower).toMatch(/kind:10002/);
  });

  it('[P0] scenarios.md covers relay evaluation (TEE-attested vs non-attested)', () => {
    const content = readFileSync(join(REFS_DIR, 'scenarios.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/tee|attestation|attested/);
    expect(lower).toMatch(/evaluat|compar/);
  });

  it('[P0] scenarios.md covers relay trust and quality signals', () => {
    const content = readFileSync(join(REFS_DIR, 'scenarios.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/trust|quality|signal/);
    expect(lower).toMatch(/ilp.?gated|paid/);
  });

  it('[P0] scenarios.md covers pricing comparison between relays', () => {
    const content = readFileSync(join(REFS_DIR, 'scenarios.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/pricing|price.*compar|compar.*price/);
  });

  it('[P0] scenarios.md covers geographic relay considerations', () => {
    const content = readFileSync(join(REFS_DIR, 'scenarios.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/geographic|region|latency|relay_countries/);
  });

  it('[P0] scenarios.md provides step-by-step TOON flows (not just descriptions)', () => {
    const content = readFileSync(join(REFS_DIR, 'scenarios.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/step|steps/);
    expect(lower).toMatch(/\/health|health.*endpoint/);
  });
});

// ─── AC8: Eval Suite [Test: EVAL-A] ─────────────────────────────────────

describe('[EVAL-A] AC8: Trigger Evals', () => {
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

  it('[P0] should-trigger queries cover protocol triggers (NIP-11, NIP-65, NIP-66, relay)', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const shouldTrigger = evals.trigger_evals
      .filter((e: { should_trigger: boolean }) => e.should_trigger === true)
      .map((e: { query: string }) => e.query.toLowerCase());
    const joined = shouldTrigger.join(' ');
    expect(joined).toMatch(/relay/);
    expect(joined).toMatch(/nip.?11|nip.?65|nip.?66/);
  });

  it('[P0] should-trigger queries cover social-situation triggers', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const shouldTrigger = evals.trigger_evals
      .filter((e: { should_trigger: boolean }) => e.should_trigger === true)
      .map((e: { query: string }) => e.query.toLowerCase());
    const joined = shouldTrigger.join(' ');
    expect(joined).toMatch(/how do i.*find|how do i.*check|which relay|how do i.*discover/);
  });

  it('[P0] should-trigger queries cover at least 5 relay-discovery-relevant terms', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const shouldTrigger = evals.trigger_evals
      .filter((e: { should_trigger: boolean }) => e.should_trigger === true)
      .map((e: { query: string }) => e.query.toLowerCase());
    const joined = shouldTrigger.join(' ');
    let found = 0;
    const terms = [
      /nip.?11/, /nip.?65/, /nip.?66/,
      /relay.*health|health.*relay/, /relay.*discover|discover.*relay/,
      /relay.*list|kind:10002/, /relay.*monitor|monitor.*relay/,
      /relay.*info/, /which relay/,
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
      /profile|channel|article|reaction|dm|direct message|follow/
    );
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

describe('[EVAL-B] AC8: Output Evals', () => {
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

  it('[P0] output evals include relay discovery assertion', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const allAssertions = evals.output_evals
      .flatMap((oe: { assertions: string[] }) => oe.assertions)
      .join(' ')
      .toLowerCase();
    expect(allAssertions).toMatch(/relay.*discover|discover.*relay|nip-11|health/);
  });

  it('[P0] output evals include TOON-enriched health endpoint assertion', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const allAssertions = evals.output_evals
      .flatMap((oe: { assertions: string[] }) => oe.assertions)
      .join(' ')
      .toLowerCase();
    expect(allAssertions).toMatch(/health.*endpoint|enriched|toon.*nip-11/);
  });

  it('[P0] output evals include fee awareness assertion', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const allAssertions = evals.output_evals
      .flatMap((oe: { assertions: string[] }) => oe.assertions)
      .join(' ')
      .toLowerCase();
    expect(allAssertions).toMatch(/fee|cost|pricing|byte/);
  });

  it('[P0] output evals include relay list publication assertion', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const allAssertions = evals.output_evals
      .flatMap((oe: { assertions: string[] }) => oe.assertions)
      .join(' ')
      .toLowerCase();
    expect(allAssertions).toMatch(/relay list|kind:10002|publishevent/);
  });

  it('[P0] read-focused output evals have at least 3 assertions', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    // Most evals are read-focused for this skill
    for (const oe of evals.output_evals) {
      expect(oe.assertions.length).toBeGreaterThanOrEqual(3);
    }
  });
});

// ─── AC9: Imperative Form and Skill Pattern [Test: STRUCT-D] ────────────

describe('[STRUCT-D] AC9: Writing Style and Skill Pattern', () => {
  it('[P1] SKILL.md body uses imperative/infinitive form (no "you should")', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const youShouldCount = (body.match(/\byou should\b/gi) || []).length;
    expect(youShouldCount).toBe(0);
  });

  it('[P0] reference files use imperative form', () => {
    for (const ref of EXPECTED_REFS) {
      const content = readFileSync(join(REFS_DIR, ref), 'utf-8');
      const youShouldCount = (content.match(/\byou should\b/gi) || []).length;
      expect(youShouldCount).toBe(0);
    }
  });

  it('[P0] reference files explain WHY (reasoning, not just rules)', () => {
    for (const ref of EXPECTED_REFS) {
      const content = readFileSync(join(REFS_DIR, ref), 'utf-8');
      const lower = content.toLowerCase();
      expect(lower).toMatch(/why|because|reason|this means|this matter/);
    }
  });
});

// ─── AC10: Description Optimization [Test: STRUCT-B] ────────────────────

describe('[STRUCT-B] AC10: Description Optimization', () => {
  it('[P1] description is between 80-120 words', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const wc = wordCount(frontmatter.description as string);
    expect(wc).toBeGreaterThanOrEqual(80);
    expect(wc).toBeLessThanOrEqual(120);
  });

  it('[P0] description includes NIP-11 trigger', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    expect(desc).toMatch(/nip.?11/);
  });

  it('[P0] description includes NIP-65 trigger', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    expect(desc).toMatch(/nip.?65/);
  });

  it('[P0] description includes NIP-66 trigger', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    expect(desc).toMatch(/nip.?66/);
  });

  it('[P0] description includes relay discovery trigger', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    expect(desc).toMatch(/relay.*discover|discover.*relay/);
  });

  it('[P0] description includes relay health trigger', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    expect(desc).toMatch(/relay.*health|health.*check|check.*relay/);
  });

  it('[P0] description includes relay list trigger', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    expect(desc).toMatch(/relay.*list|kind:10002/);
  });

  it('[P0] description includes relay evaluation trigger', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    expect(desc).toMatch(/evaluat|which relay|compar/);
  });

  it('[P0] description includes social-situation triggers', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    expect(desc).toMatch(/how do i|how do.*relay|which relay/);
  });

  it('[P1] description includes at least 2 relay-specific social-situation phrases', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    let found = 0;
    const phrases = [
      /how do i find a.*relay/,
      /how do i check relay health/,
      /which relay should i use/,
      /how do i publish my relay list/,
      /how do i discover relays/,
      /what is nip-11/,
      /how do i evaluate/,
    ];
    for (const p of phrases) {
      if (desc.match(p)) found++;
    }
    expect(found).toBeGreaterThanOrEqual(2);
  });
});

// ─── AC11: "When to Read Each Reference" Section ────────────────────────

describe('AC11: When to Read Each Reference', () => {
  it('[P0] SKILL.md body contains "When to Read Each Reference" guidance', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body.toLowerCase()).toMatch(
      /when to (read|load|consult) each reference/i
    );
  });

  it('[P0] Reference guidance mentions nip-spec.md', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/nip-spec\.md/);
  });

  it('[P0] Reference guidance mentions toon-extensions.md', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/toon-extensions\.md/);
  });

  it('[P0] Reference guidance mentions scenarios.md', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/scenarios\.md/);
  });
});

// ─── AC12: Social Context [Test: TOON-D] ────────────────────────────────

describe('[TOON-D] AC12: Social Context', () => {
  it('[P0] SKILL.md body contains ## Social Context section', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/## Social Context/);
  });

  it('[P0] Social Context has at least 80 words of relay-specific content', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const socialSection = body.split('## Social Context')[1]?.split(/\n## /)[0] || '';
    const wc = wordCount(socialSection);
    expect(wc).toBeGreaterThanOrEqual(80);
  });

  it('[P0] Social Context covers ILP-gated relays signal quality', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const socialSection = body.split('## Social Context')[1] || '';
    const lower = socialSection.toLowerCase();
    expect(lower).toMatch(/ilp.?gated|paid.*relay/);
    expect(lower).toMatch(/quality|signal|filter.*spam/);
  });

  it('[P0] Social Context covers relay selection impacts payment costs', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const socialSection = body.split('## Social Context')[1] || '';
    const lower = socialSection.toLowerCase();
    expect(lower).toMatch(/relay.*selection|select.*relay|choos/);
    expect(lower).toMatch(/cost|payment|pricing/);
  });

  it('[P0] Social Context covers relay selection impacts content visibility', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const socialSection = body.split('## Social Context')[1] || '';
    const lower = socialSection.toLowerCase();
    expect(lower).toMatch(/visibility|reach|audience/);
  });

  it('[P0] Social Context covers relay diversity for resilience', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const socialSection = body.split('## Social Context')[1] || '';
    const lower = socialSection.toLowerCase();
    expect(lower).toMatch(/diversity|resilience|redundanc|multiple/);
  });

  it('[P1] Social Context passes substitution test (relay-specific, not generic)', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const socialSection = body.split('## Social Context')[1] || '';
    const lower = socialSection.toLowerCase();
    let specificTerms = 0;
    if (lower.match(/relay/)) specificTerms++;
    if (lower.match(/nip-11|health.*endpoint/)) specificTerms++;
    if (lower.match(/pricing|basepriceperbyte/)) specificTerms++;
    if (lower.match(/tee|attestation/)) specificTerms++;
    if (lower.match(/ilp/)) specificTerms++;
    if (lower.match(/relay list|kind:10002/)) specificTerms++;
    if (lower.match(/payment_required/)) specificTerms++;
    if (lower.match(/discover|discovery/)) specificTerms++;
    expect(specificTerms).toBeGreaterThanOrEqual(5);
  });
});

// ─── AC13: Relay Information Structures [Test: STRUCT-D] ─────────────────

describe('AC13: Relay Information Structures Documentation', () => {
  it('[P0] NIP-11 JSON/HTTP structure is documented', () => {
    const allContent = readAllSkillContent().toLowerCase();
    expect(allContent).toMatch(/json/);
    expect(allContent).toMatch(/http/);
    expect(allContent).toMatch(/application\/nostr\+json/);
  });

  it('[P0] NIP-65 r tag content format is documented', () => {
    const allContent = readAllSkillContent();
    expect(allContent).toMatch(/\["r"/);
    const lower = allContent.toLowerCase();
    expect(lower).toMatch(/read/);
    expect(lower).toMatch(/write/);
  });

  it('[P0] NIP-66 tag structures are documented (d, rtt, t, r tags)', () => {
    const allContent = readAllSkillContent();
    expect(allContent).toMatch(/\["d"/);
    expect(allContent).toMatch(/rtt/);
    expect(allContent).toMatch(/\["t"/);
    expect(allContent).toMatch(/\["r"/);
  });

  it('[P0] TOON-specific field extensions are documented', () => {
    const allContent = readAllSkillContent().toLowerCase();
    expect(allContent).toMatch(/basepriceperbyte/);
    expect(allContent).toMatch(/ilpaddress|ilp.*address/);
    expect(allContent).toMatch(/chainid/);
    expect(allContent).toMatch(/x402/);
    expect(allContent).toMatch(/nitroattested/);
  });
});

// ─── AC14: Read-Focused Skill [Test: TOON-A, TOON-B] ───────────────────

describe('[TOON-A] AC14: Read-Focused Skill -- Write Model', () => {
  it('[P0] skill documents kind:10002 as the only writable event', () => {
    const allContent = readAllSkillContent().toLowerCase();
    expect(allContent).toMatch(/kind:10002.*only.*writ|only.*writ.*kind:10002|only.*kind:10002/);
  });

  it('[P0] skill uses publishEvent for kind:10002 write operations', () => {
    const allContent = readAllSkillContent();
    expect(allContent).toMatch(/publishEvent/);
  });

  it('[P0] skill documents NIP-11 as read-only (HTTP GET)', () => {
    const allContent = readAllSkillContent().toLowerCase();
    expect(allContent).toMatch(/nip-11/);
    expect(allContent).toMatch(/read.?only|http get|no.*write/);
  });

  it('[P0] skill documents NIP-66 as typically published by monitors, not end-user agents', () => {
    const allContent = readAllSkillContent().toLowerCase();
    expect(allContent).toMatch(/monitor.*operator|relay.*monitor.*publish|not.*end.?user/);
  });
});

describe('[TOON-B] AC14: Fee Awareness', () => {
  it('[P0] skill includes fee awareness for kind:10002 relay list', () => {
    const allContent = readAllSkillContent().toLowerCase();
    expect(allContent).toMatch(/per.?byte|basepriceperbyte/);
    expect(allContent).toMatch(/kind:10002/);
    expect(allContent).toMatch(/cost|fee|\$/);
  });

  it('[P0] skill includes concrete dollar estimates for relay list publication', () => {
    const allContent = readAllSkillContent().toLowerCase();
    expect(allContent).toMatch(/\$0\.\d+/);
  });

  it('[P0] skill documents that NIP-11 fetch is free (HTTP GET)', () => {
    const allContent = readAllSkillContent().toLowerCase();
    expect(allContent).toMatch(/free|no.*cost|no.*fee/);
    expect(allContent).toMatch(/http.*get|nip-11.*free|health.*free/);
  });

  it('[P0] skill documents reading is free on TOON', () => {
    const allContent = readAllSkillContent().toLowerCase();
    expect(allContent).toMatch(/read.*free|free.*read/);
  });
});

describe('[TOON-C] AC14: TOON Format', () => {
  it('[P0] skill documents TOON-format strings for relay queries', () => {
    const allContent = readAllSkillContent().toLowerCase();
    expect(allContent).toMatch(/toon.?format/);
  });

  it('[P0] skill references nostr-protocol-core for TOON format parsing', () => {
    const allContent = readAllSkillContent();
    expect(allContent).toMatch(/nostr-protocol-core/);
  });
});

// ─── AC15: No Duplication [Test: DEP-A] ─────────────────────────────────

describe('[DEP-A] AC15: No Duplication', () => {
  it('[P1] SKILL.md references nostr-protocol-core for basic write/read model', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/nostr-protocol-core/);
  });

  it('[P1] SKILL.md does NOT duplicate DVM relay routing (9-31/9-32)', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    // Should not contain DVM job routing specifics
    const dvmPatterns = /kind:5[0-9]{3}.*route|dvm.*job.*route|job.*request.*relay/;
    expect(lower).not.toMatch(dvmPatterns);
  });

  it('[P1] SKILL.md does NOT duplicate social-identity follow lists (kind:3)', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    // Should not have detailed kind:3 documentation
    const followListPattern = /kind:3\b.*follow|follow.*list.*kind:3\b/;
    expect(body.toLowerCase()).not.toMatch(followListPattern);
  });

  it('[P1] SKILL.md does NOT duplicate toon-protocol-context.md into references/', () => {
    const refFiles = readdirSync(REFS_DIR);
    expect(refFiles).not.toContain('toon-protocol-context.md');
  });
});

// ─── Token Budget [Test: STRUCT-C] ──────────────────────────────────────

describe('[STRUCT-C] Token Budget', () => {
  it('[P1] SKILL.md body is under 500 lines', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lineCount = body.split('\n').length;
    expect(lineCount).toBeLessThan(500);
  });

  it('[P1] SKILL.md body is under 3500 words (token proxy)', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const wc = wordCount(body);
    expect(wc).toBeLessThanOrEqual(3500);
  });
});

// ─── TOON Compliance Cross-Cutting ──────────────────────────────────────

describe('TOON Compliance: trigger-coverage', () => {
  it('[P0] description includes both protocol and social-situation triggers', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    // Protocol triggers
    expect(desc).toMatch(/nip.?11/);
    expect(desc).toMatch(/nip.?65/);
    expect(desc).toMatch(/nip.?66/);
    // Social-situation triggers
    expect(desc).toMatch(/how do i|how do.*relay|which relay/);
  });
});

describe('TOON Compliance: eval-completeness', () => {
  it('[P0] at least 6 trigger evals + 4 output evals', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    expect(evals.trigger_evals.length).toBeGreaterThanOrEqual(6);
    expect(evals.output_evals.length).toBeGreaterThanOrEqual(4);
  });
});

// ─── WITH/WITHOUT Baseline [Test: BASE-A] ───────────────────────────────

describe('[BASE-A] With/Without Baseline', () => {
  it('[P1] SKILL.md body provides actionable relay discovery guidance (not just NIP summary)', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    // Must contain TOON-specific guidance that adds value over base knowledge
    expect(lower).toMatch(/\/health/);
    expect(lower).toMatch(/basepriceperbyte/);
    expect(lower).toMatch(/toon/);
    // Must contain relay-specific social guidance
    expect(lower).toMatch(/relay.*select|select.*relay|which relay/);
  });

  it('[P1] scenarios.md provides step-by-step TOON relay discovery flows', () => {
    const content = readFileSync(join(REFS_DIR, 'scenarios.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/step|steps/);
    expect(lower).toMatch(/\/health|health.*endpoint/);
    expect(lower).toMatch(/fee|cost|price/);
  });
});

// ─── Cross-cutting: r Tag Consistency ───────────────────────────────────

describe('r Tag Cross-File Consistency', () => {
  it('[P0] r tag for relay URLs is documented consistently across SKILL.md and nip-spec.md', () => {
    const skillContent = readFileSync(SKILL_MD, 'utf-8');
    const nipSpec = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    expect(skillContent).toMatch(/\["r"/);
    expect(nipSpec).toMatch(/\["r"/);
  });

  it('[P0] r tag read/write markers are mentioned in scenarios.md', () => {
    const content = readFileSync(join(REFS_DIR, 'scenarios.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/read|write/);
    expect(lower).toMatch(/relay/);
  });

  it('[P0] r tag is mentioned in toon-extensions.md for relay list publication', () => {
    const content = readFileSync(join(REFS_DIR, 'toon-extensions.md'), 'utf-8');
    expect(content).toMatch(/\["r"|r.*tag/i);
  });
});

// ─── Cross-cutting: /health Endpoint Consistency ────────────────────────

describe('/health Endpoint Cross-File Consistency', () => {
  it('[P0] /health endpoint documented in SKILL.md', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/\/health/);
  });

  it('[P0] /health endpoint documented in toon-extensions.md with enriched fields', () => {
    const content = readFileSync(join(REFS_DIR, 'toon-extensions.md'), 'utf-8');
    expect(content).toMatch(/\/health/);
    const lower = content.toLowerCase();
    expect(lower).toMatch(/basepriceperbyte/);
    expect(lower).toMatch(/ilp/);
    expect(lower).toMatch(/chain/);
  });

  it('[P0] /health endpoint referenced in scenarios.md for relay evaluation', () => {
    const content = readFileSync(join(REFS_DIR, 'scenarios.md'), 'utf-8');
    expect(content).toMatch(/\/health/);
    const lower = content.toLowerCase();
    expect(lower).toMatch(/evaluat|check|compar/);
  });
});

// ─── Cross-cutting: Seed Relay Discovery Consistency ────────────────────

describe('Seed Relay Discovery Consistency', () => {
  it('[P0] kind:10036 seed relay discovery mentioned in SKILL.md', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/kind:10036/);
  });

  it('[P0] kind:10036 seed relay discovery detailed in toon-extensions.md', () => {
    const content = readFileSync(join(REFS_DIR, 'toon-extensions.md'), 'utf-8');
    expect(content).toMatch(/kind:10036/);
    const lower = content.toLowerCase();
    expect(lower).toMatch(/seed relay/);
    expect(lower).toMatch(/bootstrap/);
  });

  it('[P0] kind:10032 ILP peer info mentioned in toon-extensions.md', () => {
    const content = readFileSync(join(REFS_DIR, 'toon-extensions.md'), 'utf-8');
    expect(content).toMatch(/kind:10032/);
  });
});

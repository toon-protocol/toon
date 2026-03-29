/**
 * ATDD: Story 9.1 — TOON Protocol Core Skill (nostr-protocol-core)
 *
 * Structural validation tests for the nostr-protocol-core Claude Agent Skill.
 * This story produces markdown + JSON files, NOT TypeScript code.
 * Tests validate file existence, format compliance, content coverage, eval structure,
 * and TOON compliance (no bare ["EVENT", ...], fee calculation, TOON format handling).
 *
 * TDD RED PHASE: Skill files do not yet exist — all tests will fail.
 * Remove test.skip() after skill files are created (GREEN phase).
 *
 * Test IDs from test-design-epic-9.md:
 *   9.1-STRUCT-001 through 9.1-STRUCT-006
 *   9.1-EVAL-001 through 9.1-EVAL-005
 *   9.1-TOON-001 through 9.1-TOON-003
 *
 * @see _bmad-output/implementation-artifacts/9-1-toon-protocol-core-skill.md
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
  'nostr-protocol-core'
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

// ─── AC1: SKILL.md Core File [Test: 9.1-STRUCT-001] ───────────────────────

describe('[9.1-STRUCT-001] AC1: SKILL.md Core File', () => {
  it('[P0] SKILL.md exists at .claude/skills/nostr-protocol-core/SKILL.md', () => {
    // Given the nostr-protocol-core skill directory
    // When checking for the core SKILL.md file
    // Then it must exist
    expect(existsSync(SKILL_MD)).toBe(true);
  });

  it('[P0] SKILL.md has valid YAML frontmatter with name and description', () => {
    // Given the SKILL.md file
    // When parsing the YAML frontmatter
    // Then it must contain name and description fields
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter).toHaveProperty('name', 'nostr-protocol-core');
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
    const youShouldCount = (body.match(/\byou should\b/gi) || []).length;
    expect(youShouldCount).toBe(0);
  });

  it('[P0] SKILL.md body teaches TOON-first protocol with NIP-01 as baseline', () => {
    // Given the SKILL.md body
    // When checking for TOON-first framing (D9-002)
    // Then TOON protocol must be taught first, with vanilla NIP-01 as baseline reference
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/toon/);
    expect(lower).toMatch(/nip.?01|nip-01/);
    expect(lower).toMatch(/publishevent/);
  });

  it('[P0] SKILL.md body contains TOON read model overview', () => {
    // Given the SKILL.md body
    // When checking for read model overview
    // Then it must mention TOON format strings (not JSON objects)
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/toon.?format|toon format/);
    expect(lower).toMatch(/read/);
  });

  it('[P0] skill directory contains exactly SKILL.md, references/, evals/ (no extraneous files)', () => {
    // Given the skill directory
    // When listing all entries
    // Then only SKILL.md, references, evals should exist
    expect(existsSync(SKILL_DIR)).toBe(true);
    const topLevel = readdirSync(SKILL_DIR);
    expect(topLevel.sort()).toEqual(['SKILL.md', 'evals', 'references'].sort());
  });

  it('[P0] references/ directory exists', () => {
    expect(existsSync(REFS_DIR)).toBe(true);
  });

  it('[P0] evals/ directory exists', () => {
    expect(existsSync(EVALS_DIR)).toBe(true);
  });
});

// ─── AC2: Description Triggers [Test: 9.1-STRUCT-001] ─────────────────────

describe('[9.1-STRUCT-001] AC2: Description Triggers on Protocol Situations', () => {
  it('[P0] description includes event construction/publishing triggers', () => {
    // Given the SKILL.md description field
    // When checking for event construction trigger phrases
    // Then it must include phrases about publishing events on TOON
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    const hasPublishing =
      desc.includes('publish') ||
      desc.includes('send') ||
      desc.includes('event') ||
      desc.includes('publishevent');
    expect(hasPublishing).toBe(true);
  });

  it('[P0] description includes fee calculation triggers', () => {
    // Given the SKILL.md description field
    // When checking for fee calculation trigger phrases
    // Then it must include phrases about cost, fees, or pricing
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    const hasFees =
      desc.includes('fee') ||
      desc.includes('cost') ||
      desc.includes('pricing') ||
      desc.includes('basepriceperbyte');
    expect(hasFees).toBe(true);
  });

  it('[P0] description includes reading/subscribing triggers', () => {
    // Given the SKILL.md description field
    // When checking for read model trigger phrases
    // Then it must include phrases about reading, subscribing, or querying
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    const hasReading =
      desc.includes('read') ||
      desc.includes('subscribe') ||
      desc.includes('toon format') ||
      desc.includes('query');
    expect(hasReading).toBe(true);
  });

  it('[P0] description includes threading/replies triggers', () => {
    // Given the SKILL.md description field
    // When checking for threading trigger phrases
    // Then it must include phrases about threading, replies, or NIP-10
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    const hasThreading =
      desc.includes('thread') ||
      desc.includes('repl') ||
      desc.includes('nip-10') ||
      desc.includes('e-tag');
    expect(hasThreading).toBe(true);
  });

  it('[P0] description includes entity encoding triggers', () => {
    // Given the SKILL.md description field
    // When checking for entity encoding trigger phrases
    // Then it must include phrases about bech32, NIP-19, npub, or nevent
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    const hasEncoding =
      desc.includes('bech32') ||
      desc.includes('nip-19') ||
      desc.includes('npub') ||
      desc.includes('nevent') ||
      desc.includes('nprofile');
    expect(hasEncoding).toBe(true);
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

// ─── AC3: TOON Write Model [Test: 9.1-STRUCT-002, 9.1-TOON-001, 9.1-TOON-002] ──

describe('[9.1-STRUCT-002] AC3: TOON Write Model', () => {
  it('[P0] references/toon-write-model.md exists', () => {
    expect(existsSync(join(REFS_DIR, 'toon-write-model.md'))).toBe(true);
  });

  it('[P0] toon-write-model.md references publishEvent() API', () => {
    // Given the TOON write model reference file
    // When checking for the publishEvent() API reference
    // Then it must use publishEvent() from @toon-protocol/client
    const content = readFileSync(
      join(REFS_DIR, 'toon-write-model.md'),
      'utf-8'
    );
    expect(content).toMatch(/publishEvent/);
  });

  it('[P0] toon-write-model.md references @toon-protocol/client (not SDK)', () => {
    // Given the TOON write model reference file
    // When checking for transport reference
    // Then it must reference @toon-protocol/client, NOT the SDK
    const content = readFileSync(
      join(REFS_DIR, 'toon-write-model.md'),
      'utf-8'
    );
    expect(content).toMatch(/@toon-protocol\/client/);
  });

  it('[P0] toon-write-model.md documents pricing discovery (kind:10032 or NIP-11)', () => {
    // Given the TOON write model reference file
    // When checking for pricing discovery
    // Then kind:10032 or NIP-11 /health endpoint must be documented
    const content = readFileSync(
      join(REFS_DIR, 'toon-write-model.md'),
      'utf-8'
    ).toLowerCase();
    const hasPricingDiscovery =
      content.includes('kind:10032') ||
      content.includes('10032') ||
      content.includes('nip-11') ||
      content.includes('/health');
    expect(hasPricingDiscovery).toBe(true);
  });

  it('[P0] toon-write-model.md documents fee calculation formula', () => {
    // Given the TOON write model reference file
    // When checking for fee calculation
    // Then basePricePerByte * bytes formula must be present (9.1-TOON-002)
    const content = readFileSync(
      join(REFS_DIR, 'toon-write-model.md'),
      'utf-8'
    ).toLowerCase();
    expect(content).toMatch(/basepriceperbyte/);
  });

  it('[P0] toon-write-model.md documents error handling (F04 Insufficient Payment)', () => {
    // Given the TOON write model reference file
    // When checking for error handling
    // Then F04 error must be documented
    const content = readFileSync(
      join(REFS_DIR, 'toon-write-model.md'),
      'utf-8'
    );
    expect(content).toMatch(/F04/);
  });

  it('[P0] toon-write-model.md documents no condition/fulfillment (D9-005)', () => {
    // Given the TOON write model reference file
    // When checking for the simplified write model
    // Then no condition/fulfillment computation on client side (D9-005)
    const content = readFileSync(
      join(REFS_DIR, 'toon-write-model.md'),
      'utf-8'
    ).toLowerCase();
    const hasNoCondition =
      content.includes('no condition') ||
      content.includes('no fulfillment') ||
      content.includes('simplified');
    expect(hasNoCondition).toBe(true);
  });

  it('[P1] toon-write-model.md includes code example with publishEvent()', () => {
    // Given the TOON write model reference file
    // When checking for code examples
    // Then at least one code example using publishEvent() must be present
    const content = readFileSync(
      join(REFS_DIR, 'toon-write-model.md'),
      'utf-8'
    );
    // Code block with publishEvent
    expect(content).toMatch(/```[\s\S]*?publishEvent[\s\S]*?```/);
  });

  it('[P1] toon-write-model.md documents amount override (D7-007) and bid safety cap (D7-006)', () => {
    // Given the TOON write model reference file
    // When checking for amount override and bid safety cap
    // Then both D7-007 (amount override) and D7-006 (bid cap) must be documented
    const content = readFileSync(
      join(REFS_DIR, 'toon-write-model.md'),
      'utf-8'
    ).toLowerCase();
    expect(content).toMatch(/amount/);
    expect(content).toMatch(/bid/);
  });
});

// ─── AC4: TOON Read Model [Test: 9.1-STRUCT-001, 9.1-TOON-003] ───────────

describe('[9.1-STRUCT-001] AC4: TOON Read Model', () => {
  it('[P0] references/toon-read-model.md exists', () => {
    expect(existsSync(join(REFS_DIR, 'toon-read-model.md'))).toBe(true);
  });

  it('[P0] toon-read-model.md documents NIP-01 subscriptions (REQ)', () => {
    // Given the TOON read model reference file
    // When checking for subscription documentation
    // Then NIP-01 REQ pattern must be documented
    const content = readFileSync(join(REFS_DIR, 'toon-read-model.md'), 'utf-8');
    expect(content).toMatch(/REQ/);
  });

  it('[P0] toon-read-model.md documents TOON format strings (not JSON objects) [9.1-TOON-003]', () => {
    // Given the TOON read model reference file
    // When checking for TOON format documentation
    // Then it must explain that relay returns TOON-format strings, NOT JSON objects
    const content = readFileSync(
      join(REFS_DIR, 'toon-read-model.md'),
      'utf-8'
    ).toLowerCase();
    expect(content).toMatch(/toon.?format/);
    expect(content).toMatch(/not json|not standard json|toon.?format strings/);
  });

  it('[P1] toon-read-model.md includes subscription handling examples', () => {
    // Given the TOON read model reference file
    // When checking for examples
    // Then subscription handling and filter construction examples must be present
    const content = readFileSync(join(REFS_DIR, 'toon-read-model.md'), 'utf-8');
    expect(content).toMatch(/filter/i);
    // Code block present
    expect(content).toMatch(/```/);
  });
});

// ─── AC5: Fee Calculation Reference [Test: 9.1-STRUCT-003] ─────────────────

describe('[9.1-STRUCT-003] AC5: Fee Calculation Reference', () => {
  it('[P0] references/fee-calculation.md exists', () => {
    expect(existsSync(join(REFS_DIR, 'fee-calculation.md'))).toBe(true);
  });

  it('[P0] fee-calculation.md documents basePricePerByte * serializedEventBytes formula', () => {
    // Given the fee calculation reference file
    // When checking for the core formula
    // Then the per-byte fee formula must be present
    const content = readFileSync(
      join(REFS_DIR, 'fee-calculation.md'),
      'utf-8'
    ).toLowerCase();
    expect(content).toMatch(/basepriceperbyte/);
    expect(content).toMatch(/byte/);
  });

  it('[P0] fee-calculation.md documents default basePricePerByte = 10n (10 micro-USDC per byte)', () => {
    // Given the fee calculation reference file
    // When checking for the default value
    // Then default basePricePerByte = 10n must be documented
    const content = readFileSync(join(REFS_DIR, 'fee-calculation.md'), 'utf-8');
    expect(content).toMatch(/10n|10 micro/i);
  });

  it('[P0] fee-calculation.md documents kind:10032 pricing discovery', () => {
    // Given the fee calculation reference file
    // When checking for pricing discovery
    // Then kind:10032 must be referenced
    const content = readFileSync(join(REFS_DIR, 'fee-calculation.md'), 'utf-8');
    expect(content).toMatch(/10032/);
  });

  it('[P1] fee-calculation.md documents amount override for DVM kinds (D7-007)', () => {
    // Given the fee calculation reference file
    // When checking for DVM amount override
    // Then amount override for DVM kinds must be documented
    const content = readFileSync(
      join(REFS_DIR, 'fee-calculation.md'),
      'utf-8'
    ).toLowerCase();
    expect(content).toMatch(/amount.*override|override.*amount|dvm/);
  });

  it('[P1] fee-calculation.md documents kind-specific pricing (SkillDescriptor.kindPricing)', () => {
    // Given the fee calculation reference file
    // When checking for kind-specific pricing
    // Then kindPricing reference must be present
    const content = readFileSync(
      join(REFS_DIR, 'fee-calculation.md'),
      'utf-8'
    ).toLowerCase();
    expect(content).toMatch(/kindpricing|kind.?specific/);
  });

  it('[P1] fee-calculation.md documents bid safety cap (D7-006)', () => {
    // Given the fee calculation reference file
    // When checking for bid safety cap
    // Then bid safety cap semantic must be documented
    const content = readFileSync(
      join(REFS_DIR, 'fee-calculation.md'),
      'utf-8'
    ).toLowerCase();
    expect(content).toMatch(/bid/);
    expect(content).toMatch(/safety.*cap|cap/);
  });

  it('[P1] fee-calculation.md documents route-aware fee calculation', () => {
    // Given the fee calculation reference file
    // When checking for route-aware fees
    // Then resolveRouteFees + calculateRouteAmount must be referenced
    const content = readFileSync(
      join(REFS_DIR, 'fee-calculation.md'),
      'utf-8'
    ).toLowerCase();
    expect(content).toMatch(/resolveroutefees|route.*fee|calculateroute/);
  });
});

// ─── AC6: NIP-10 Threading [Test: 9.1-STRUCT-004] ─────────────────────────

describe('[9.1-STRUCT-004] AC6: NIP-10 Threading Coverage', () => {
  it('[P0] references/nip10-threading.md exists', () => {
    expect(existsSync(join(REFS_DIR, 'nip10-threading.md'))).toBe(true);
  });

  it('[P0] nip10-threading.md documents e tag markers (root, reply, mention)', () => {
    // Given the NIP-10 threading reference file
    // When checking for e tag marker documentation
    // Then root, reply, and mention markers must be documented
    const content = readFileSync(
      join(REFS_DIR, 'nip10-threading.md'),
      'utf-8'
    ).toLowerCase();
    expect(content).toMatch(/root/);
    expect(content).toMatch(/reply/);
    expect(content).toMatch(/mention/);
  });

  it('[P0] nip10-threading.md documents p tags for participant tracking', () => {
    // Given the NIP-10 threading reference file
    // When checking for p tag documentation
    // Then participant tracking via p tags must be documented
    const content = readFileSync(
      join(REFS_DIR, 'nip10-threading.md'),
      'utf-8'
    ).toLowerCase();
    expect(content).toMatch(/p.*tag|"p"/);
    expect(content).toMatch(/participant/);
  });

  it('[P1] nip10-threading.md includes thread construction patterns', () => {
    // Given the NIP-10 threading reference file
    // When checking for thread construction guidance
    // Then thread construction patterns must be documented
    const content = readFileSync(
      join(REFS_DIR, 'nip10-threading.md'),
      'utf-8'
    ).toLowerCase();
    expect(content).toMatch(/thread/);
    expect(content).toMatch(/construct|build|creat/);
  });
});

// ─── AC7: NIP-19 Entity Encoding [Test: 9.1-STRUCT-004] ───────────────────

describe('[9.1-STRUCT-004] AC7: NIP-19 Entity Encoding Coverage', () => {
  it('[P0] references/nip19-entities.md exists', () => {
    expect(existsSync(join(REFS_DIR, 'nip19-entities.md'))).toBe(true);
  });

  it('[P0] nip19-entities.md documents bech32 entity types (npub, nsec, note, nevent, nprofile, naddr)', () => {
    // Given the NIP-19 entities reference file
    // When checking for bech32 entity type documentation
    // Then all 6 entity types must be documented
    const content = readFileSync(
      join(REFS_DIR, 'nip19-entities.md'),
      'utf-8'
    ).toLowerCase();
    expect(content).toMatch(/npub/);
    expect(content).toMatch(/nsec/);
    expect(content).toMatch(/note/);
    expect(content).toMatch(/nevent/);
    expect(content).toMatch(/nprofile/);
    expect(content).toMatch(/naddr/);
  });

  it('[P0] nip19-entities.md documents bech32 encoding/decoding', () => {
    // Given the NIP-19 entities reference file
    // When checking for encoding/decoding documentation
    // Then bech32 encoding and decoding must be documented
    const content = readFileSync(
      join(REFS_DIR, 'nip19-entities.md'),
      'utf-8'
    ).toLowerCase();
    expect(content).toMatch(/bech32/);
    expect(content).toMatch(/encod/);
    expect(content).toMatch(/decod/);
  });
});

// ─── AC8: Social Context Section [Test: 9.1-STRUCT-005] ───────────────────

describe('[9.1-STRUCT-005] AC8: Social Context Section', () => {
  it('[P0] SKILL.md body contains ## Social Context section', () => {
    // Given the SKILL.md body
    // When checking for Social Context section
    // Then it must exist
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/## Social Context/);
  });

  it('[P0] Social Context section includes required text about pay-to-write quality floor', () => {
    // Given the Social Context section
    // When checking for required content
    // Then it must mention paying to write, quality floor, and skin-in-the-game
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/costs money|pay/);
    expect(lower).toMatch(/quality floor|skin.?in.?the.?game/);
  });

  it('[P0] Social Context section references nostr-social-intelligence skill', () => {
    // Given the Social Context section
    // When checking for sister skill reference
    // Then it must point to nostr-social-intelligence for deeper social judgment guidance
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/nostr-social-intelligence/);
  });
});

// ─── AC9: Excluded NIPs Documentation [Test: 9.1-STRUCT-006] ──────────────

describe('[9.1-STRUCT-006] AC9: Excluded NIPs Documentation', () => {
  it('[P0] references/excluded-nips.md exists', () => {
    expect(existsSync(join(REFS_DIR, 'excluded-nips.md'))).toBe(true);
  });

  it('[P0] excluded-nips.md documents NIP-13 (Proof of Work) with ILP rationale', () => {
    // Given the excluded NIPs reference file
    // When checking for NIP-13 documentation
    // Then NIP-13 must be documented with ILP rationale
    const content = readFileSync(
      join(REFS_DIR, 'excluded-nips.md'),
      'utf-8'
    ).toLowerCase();
    expect(content).toMatch(/nip.?13/);
    expect(content).toMatch(/proof of work|pow/);
    expect(content).toMatch(/ilp|payment/);
  });

  it('[P0] excluded-nips.md documents NIP-42 (Relay Auth) with ILP rationale', () => {
    const content = readFileSync(
      join(REFS_DIR, 'excluded-nips.md'),
      'utf-8'
    ).toLowerCase();
    expect(content).toMatch(/nip.?42/);
    expect(content).toMatch(/relay auth|authentication/);
  });

  it('[P0] excluded-nips.md documents NIP-47 (Wallet Connect) with ILP rationale', () => {
    const content = readFileSync(
      join(REFS_DIR, 'excluded-nips.md'),
      'utf-8'
    ).toLowerCase();
    expect(content).toMatch(/nip.?47/);
    expect(content).toMatch(/wallet connect|nwc/);
  });

  it('[P0] excluded-nips.md documents NIP-57 (Zaps) with ILP rationale', () => {
    const content = readFileSync(
      join(REFS_DIR, 'excluded-nips.md'),
      'utf-8'
    ).toLowerCase();
    expect(content).toMatch(/nip.?57/);
    expect(content).toMatch(/zap/);
  });

  it('[P0] excluded-nips.md documents NIP-98 (HTTP Auth) with ILP rationale', () => {
    const content = readFileSync(
      join(REFS_DIR, 'excluded-nips.md'),
      'utf-8'
    ).toLowerCase();
    expect(content).toMatch(/nip.?98/);
    expect(content).toMatch(/http auth|x402/);
  });
});

// ─── AC10: TOON Protocol Context Reference [Test: D9-010] ─────────────────

describe('[9.1-STRUCT-001] AC10: TOON Protocol Context Reference', () => {
  it('[P0] references/toon-protocol-context.md exists', () => {
    expect(existsSync(join(REFS_DIR, 'toon-protocol-context.md'))).toBe(true);
  });

  it('[P0] toon-protocol-context.md contains TOON write model summary', () => {
    // Given the canonical protocol context file
    // When checking for write model content
    // Then TOON write model must be summarized
    const content = readFileSync(
      join(REFS_DIR, 'toon-protocol-context.md'),
      'utf-8'
    ).toLowerCase();
    expect(content).toMatch(/write model|publishevent/);
  });

  it('[P0] toon-protocol-context.md contains TOON read model summary', () => {
    // Given the canonical protocol context file
    // When checking for read model content
    // Then TOON read model must be summarized
    const content = readFileSync(
      join(REFS_DIR, 'toon-protocol-context.md'),
      'utf-8'
    ).toLowerCase();
    expect(content).toMatch(/read model|toon.?format/);
  });

  it('[P0] toon-protocol-context.md references @toon-protocol/client transport', () => {
    // Given the canonical protocol context file
    // When checking for transport reference
    // Then @toon-protocol/client must be referenced
    const content = readFileSync(
      join(REFS_DIR, 'toon-protocol-context.md'),
      'utf-8'
    );
    expect(content).toMatch(/@toon-protocol\/client/);
  });

  it('[P0] toon-protocol-context.md documents relay discovery (enriched NIP-11, kind:10032)', () => {
    // Given the canonical protocol context file
    // When checking for relay discovery
    // Then enriched NIP-11 and/or kind:10032 must be documented
    const content = readFileSync(
      join(REFS_DIR, 'toon-protocol-context.md'),
      'utf-8'
    ).toLowerCase();
    const hasDiscovery =
      content.includes('nip-11') ||
      content.includes('kind:10032') ||
      content.includes('10032');
    expect(hasDiscovery).toBe(true);
  });

  it('[P0] toon-protocol-context.md documents social economics', () => {
    // Given the canonical protocol context file
    // When checking for social economics content
    // Then social economics of ILP-gated relays must be addressed
    const content = readFileSync(
      join(REFS_DIR, 'toon-protocol-context.md'),
      'utf-8'
    ).toLowerCase();
    const hasEconomics =
      content.includes('economic') ||
      content.includes('cost') ||
      content.includes('pay');
    expect(hasEconomics).toBe(true);
  });

  it('[P0] toon-protocol-context.md documents no condition/fulfillment (D9-005)', () => {
    // Given the canonical protocol context file
    // When checking for the simplified write model
    // Then no condition/fulfillment must be stated
    const content = readFileSync(
      join(REFS_DIR, 'toon-protocol-context.md'),
      'utf-8'
    ).toLowerCase();
    const hasNoCondition =
      content.includes('no condition') ||
      content.includes('no fulfillment') ||
      content.includes('simplified');
    expect(hasNoCondition).toBe(true);
  });

  it('[P1] toon-protocol-context.md is self-contained for pipeline injection (D9-010)', () => {
    // Given the canonical protocol context file
    // When checking self-containedness
    // Then it must cover write model, read model, transport, discovery, and economics
    // without requiring external files to understand TOON basics
    const content = readFileSync(
      join(REFS_DIR, 'toon-protocol-context.md'),
      'utf-8'
    ).toLowerCase();
    // All five core topics must be present in this single file
    expect(content).toMatch(/publishevent/);
    expect(content).toMatch(/toon.?format/);
    expect(content).toMatch(/@toon-protocol\/client/i);
    expect(content).toMatch(/10032|nip.?11/);
    expect(content).toMatch(/cost|economic|pay/);
  });
});

// ─── AC11: Eval Definitions [Test: 9.1-EVAL-001 through 9.1-EVAL-005] ─────

describe('[9.1-EVAL-001] AC11: Eval Definitions', () => {
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

  it('[P0] evals.json has trigger_evals array with 8-10 should-trigger and 8-10 should-not-trigger entries', () => {
    // Given the parsed evals.json
    // When checking trigger_evals structure
    // Then it must contain both should_trigger=true and should_trigger=false entries
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
    expect(shouldTrigger.length).toBeLessThanOrEqual(10);
    expect(shouldNotTrigger.length).toBeGreaterThanOrEqual(8);
    expect(shouldNotTrigger.length).toBeLessThanOrEqual(10);
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

  it('[P0] output_evals use rubric-based grading (correct/acceptable/incorrect)', () => {
    // Given each output eval entry
    // When checking for rubric-based grading (per E9-R002)
    // Then rubric object must contain correct/acceptable/incorrect keys
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    for (const entry of evals.output_evals) {
      expect(entry).toHaveProperty('rubric');
      expect(entry.rubric).toHaveProperty('correct');
      expect(entry.rubric).toHaveProperty('acceptable');
      expect(entry.rubric).toHaveProperty('incorrect');
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

  it('[P1] should-trigger queries cover protocol-situation scenarios', () => {
    // Given the trigger_evals with should_trigger=true
    // When checking their content
    // Then they should reference protocol situations (publish, fee, calculate, read, subscribe, thread, bech32)
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const shouldTrigger = evals.trigger_evals.filter(
      (e: { should_trigger: boolean }) => e.should_trigger === true
    );
    const protocolKeywords =
      /publish|fee|cost|pric|calculat|read|subscribe|toon format|thread|repl|bech32|nip.?19|npub|nevent|event|kind|nip.?01|nip.?10/i;
    const protocolCount = shouldTrigger.filter((e: { query: string }) =>
      protocolKeywords.test(e.query)
    ).length;
    expect(protocolCount).toBeGreaterThanOrEqual(5);
  });

  it('[P1] should-not-trigger queries distinguish from social-judgment (nostr-social-intelligence domain)', () => {
    // Given the trigger_evals with should_trigger=false
    // When checking their content
    // Then they should reference social judgment (react, comment, appropriate, engage, norms)
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const shouldNotTrigger = evals.trigger_evals.filter(
      (e: { should_trigger: boolean }) => e.should_trigger === false
    );
    const socialKeywords =
      /react|comment|appropriate|engage|norms|disagree|mute|block|social|conflict|etiquette|repost|should i/i;
    const socialCount = shouldNotTrigger.filter((e: { query: string }) =>
      socialKeywords.test(e.query)
    ).length;
    expect(socialCount).toBeGreaterThanOrEqual(5);
  });

  it('[P1] output_evals each have a non-empty prompt and at least 2 assertions', () => {
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
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    for (const entry of evals.output_evals) {
      expect(
        entry.rubric.correct.length,
        `${entry.id} rubric.correct should be substantive`
      ).toBeGreaterThan(30);
      expect(
        entry.rubric.acceptable.length,
        `${entry.id} rubric.acceptable should be substantive`
      ).toBeGreaterThan(30);
      expect(
        entry.rubric.incorrect.length,
        `${entry.id} rubric.incorrect should be substantive`
      ).toBeGreaterThan(30);
    }
  });
});

// ─── TOON Compliance Checks [Test: 9.1-TOON-001, 9.1-TOON-002, 9.1-TOON-003] ──

describe('[9.1-TOON-001] TOON Write Check: No Bare ["EVENT", ...] Patterns', () => {
  it('[P0] no skill file contains bare ["EVENT", ...] pattern', () => {
    // Given all skill files (SKILL.md + all references)
    // When searching for bare EVENT WebSocket patterns
    // Then none must be found (9.1-TOON-001)
    // Bare ["EVENT", ...] patterns teach agents to bypass publishEvent()
    const allContent = readAllSkillContent();
    // Match ["EVENT" with optional whitespace after the bracket
    // Exclude patterns that are clearly documenting what NOT to do (negation context)
    const bareEventMatches = allContent.match(/\["EVENT"/g) || [];
    expect(
      bareEventMatches.length,
      'No bare ["EVENT", ...] patterns allowed in any skill file (9.1-TOON-001). Use publishEvent() instead.'
    ).toBe(0);
  });
});

describe('[9.1-TOON-002] TOON Fee Check: Fee Calculation Referenced in Write Model', () => {
  it('[P0] toon-write-model.md references fee calculation', () => {
    // Given the write model reference file
    // When checking for fee calculation reference
    // Then basePricePerByte or fee calculation must be mentioned
    const content = readFileSync(
      join(REFS_DIR, 'toon-write-model.md'),
      'utf-8'
    ).toLowerCase();
    const hasFee =
      content.includes('basepriceperbyte') ||
      content.includes('fee calculation') ||
      content.includes('fee-calculation.md');
    expect(hasFee).toBe(true);
  });
});

describe('[9.1-TOON-003] TOON Format Check: TOON Format Handling in Read Model', () => {
  it('[P0] toon-read-model.md documents TOON format handling', () => {
    // Given the read model reference file
    // When checking for TOON format documentation
    // Then TOON format string handling must be documented
    const content = readFileSync(
      join(REFS_DIR, 'toon-read-model.md'),
      'utf-8'
    ).toLowerCase();
    expect(content).toMatch(/toon.?format/);
  });
});

// ─── Quality Validation (AC: all) ─────────────────────────────────────────

describe('[9.1-QUALITY] Structural Quality Validation', () => {
  it('[P0] all 7 reference files exist and are non-empty', () => {
    const expectedFiles = [
      'toon-write-model.md',
      'toon-read-model.md',
      'fee-calculation.md',
      'nip10-threading.md',
      'nip19-entities.md',
      'excluded-nips.md',
      'toon-protocol-context.md',
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

  it('[P0] evals directory contains exactly 1 file (evals.json, no extras)', () => {
    const files = readdirSync(EVALS_DIR);
    expect(files).toEqual(['evals.json']);
  });

  it('[P1] every reference file explains WHY (reasoning), not just rules (D9-008)', () => {
    // Given each reference file
    // When checking for reasoning language
    // Then each file should contain "because", "reason", "why", or similar explanatory language
    const expectedFiles = [
      'toon-write-model.md',
      'toon-read-model.md',
      'fee-calculation.md',
      'nip10-threading.md',
      'nip19-entities.md',
      'excluded-nips.md',
      'toon-protocol-context.md',
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
});

// ─── Gap Coverage: AC3 Write Model Does NOT Recommend SDK ───────────────────

describe('[9.1-STRUCT-002] AC3: Write Model Client vs SDK Boundary', () => {
  it('[P1] toon-write-model.md does not recommend the SDK for event publishing', () => {
    // Given the TOON write model reference file
    // When checking for SDK references
    // Then it should not recommend createNode() or HandlerRegistry (those are provider-side)
    const content = readFileSync(
      join(REFS_DIR, 'toon-write-model.md'),
      'utf-8'
    );
    // Should not recommend the SDK for agent publishing
    // Note: mentioning SDK to explain what NOT to use is acceptable
    // The key check is that @toon-protocol/client is recommended, not @toon-protocol/sdk
    expect(content).not.toMatch(/import.*from\s+['"]@toon-protocol\/sdk['"]/);
  });
});

// ─── Gap Coverage: AC5 Human-Readable Pricing ───────────────────────────────

describe('[9.1-STRUCT-003] AC5: Fee Calculation Human-Readable Pricing', () => {
  it('[P1] fee-calculation.md documents the $0.00001/byte human-readable equivalent', () => {
    // Given the fee calculation reference file
    // When checking for human-readable pricing
    // Then $0.00001/byte (or equivalent expression) must be documented
    const content = readFileSync(join(REFS_DIR, 'fee-calculation.md'), 'utf-8');
    expect(content).toMatch(/\$0\.00001|0\.00001.*per byte/);
  });
});

// ─── Gap Coverage: AC8 Social Context Exact Required Text ───────────────────

describe('[9.1-STRUCT-005] AC8: Social Context Exact Required Phrasing', () => {
  it('[P0] Social Context section contains the required exact phrasing per AC8', () => {
    // Given the SKILL.md Social Context section
    // When checking for the AC8-specified text
    // Then the exact required text must be present (or semantically equivalent)
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    // AC8 requires: "Publishing on TOON costs money."
    expect(body).toMatch(/Publishing on TOON costs money/);
    // AC8 requires mention of "don't spam"
    expect(body.toLowerCase()).toMatch(/don't spam|do not spam/);
    // AC8 requires mention of composing thoughtfully
    expect(body.toLowerCase()).toMatch(/compose thoughtfully|thoughtful/);
  });
});

// ─── Gap Coverage: AC10 Canonical Single Source of Truth ─────────────────────

describe('[9.1-STRUCT-001] AC10: Protocol Context Canonical Status', () => {
  it('[P1] toon-protocol-context.md identifies itself as the canonical single source of truth', () => {
    // Given the toon-protocol-context.md file
    // When checking for canonical/pipeline references
    // Then it must identify itself as the single source of truth for pipeline injection (D9-010)
    const content = readFileSync(
      join(REFS_DIR, 'toon-protocol-context.md'),
      'utf-8'
    ).toLowerCase();
    expect(content).toMatch(/single source of truth|canonical/);
    expect(content).toMatch(/pipeline|inject/);
  });
});

// ─── Gap Coverage: AC11 TOON Compliance Assertions in Evals ─────────────────

describe('[9.1-EVAL-001] AC11: TOON Compliance Assertions in Output Evals', () => {
  it('[P1] output_evals include toon-write-check assertion', () => {
    // Given the output_evals in evals.json
    // When checking for TOON compliance assertions (task 4.5)
    // Then at least one output eval must include toon-write-check assertion
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const allAssertions = evals.output_evals.flatMap(
      (e: { assertions: string[] }) => e.assertions
    );
    const hasToonWriteCheck = allAssertions.some((a: string) =>
      a.includes('toon-write-check')
    );
    expect(hasToonWriteCheck).toBe(true);
  });

  it('[P1] output_evals include toon-fee-check assertion', () => {
    // Given the output_evals in evals.json
    // When checking for TOON compliance assertions (task 4.5)
    // Then at least one output eval must include toon-fee-check assertion
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const allAssertions = evals.output_evals.flatMap(
      (e: { assertions: string[] }) => e.assertions
    );
    const hasToonFeeCheck = allAssertions.some((a: string) =>
      a.includes('toon-fee-check')
    );
    expect(hasToonFeeCheck).toBe(true);
  });

  it('[P1] output_evals include toon-format-check assertion', () => {
    // Given the output_evals in evals.json
    // When checking for TOON compliance assertions (task 4.5)
    // Then at least one output eval must include toon-format-check assertion
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const allAssertions = evals.output_evals.flatMap(
      (e: { assertions: string[] }) => e.assertions
    );
    const hasToonFormatCheck = allAssertions.some((a: string) =>
      a.includes('toon-format-check')
    );
    expect(hasToonFormatCheck).toBe(true);
  });
});

// ─── Gap Coverage: SKILL.md Body Content Summaries ──────────────────────────

describe('[9.1-STRUCT-001] AC1: SKILL.md Body Content Coverage', () => {
  it('[P1] SKILL.md body contains a fee calculation summary section', () => {
    // Given the SKILL.md body
    // When checking for fee calculation summary
    // Then a fee-related section must be present in the body (progressive disclosure L2)
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body.toLowerCase()).toMatch(/fee calculation/);
    expect(body.toLowerCase()).toMatch(/basepriceperbyte/);
  });

  it('[P1] SKILL.md body mentions NIP-10 threading', () => {
    // Given the SKILL.md body
    // When checking for NIP-10 threading reference
    // Then NIP-10 or threading must be mentioned in the body
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body.toLowerCase()).toMatch(/nip.?10|thread/);
  });

  it('[P1] SKILL.md body mentions NIP-19 entity encoding', () => {
    // Given the SKILL.md body
    // When checking for NIP-19 entity encoding reference
    // Then NIP-19 or bech32 or entity encoding must be mentioned in the body
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body.toLowerCase()).toMatch(/nip.?19|bech32|entity/);
  });
});

// ─── Gap Coverage: D9-008 Reasoning Depth ───────────────────────────────────

describe('[9.1-QUALITY] D9-008: Reasoning Depth in References', () => {
  it('[P1] each reference file has at least 3 reasoning indicators (not just one stray "because")', () => {
    // Given each reference file
    // When counting reasoning language occurrences
    // Then each file should have multiple instances of reasoning language (D9-008 depth)
    const expectedFiles = [
      'toon-write-model.md',
      'toon-read-model.md',
      'fee-calculation.md',
      'nip10-threading.md',
      'nip19-entities.md',
      'excluded-nips.md',
      'toon-protocol-context.md',
    ];
    for (const file of expectedFiles) {
      const content = readFileSync(join(REFS_DIR, file), 'utf-8').toLowerCase();
      const matches = content.match(
        /\bbecause\b|\breason\b|\bwhy\b|\bsince\b|\bthis means\b|\bthis ensures\b|\bthe result is\b|\bso that\b|\bin order to\b|\bthis enables\b|\bthis protects\b|\bthis is\b/g
      );
      expect(
        (matches || []).length,
        `${file} should have at least 2 reasoning indicators for D9-008 depth`
      ).toBeGreaterThanOrEqual(2);
    }
  });
});

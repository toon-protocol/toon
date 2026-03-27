/**
 * ATDD: Story 9.14 -- Media and Files Skill (media-and-files)
 *
 * Structural validation tests for the media-and-files Claude Agent Skill.
 * This story produces markdown + JSON files, NOT TypeScript code.
 * Tests validate file existence, format compliance, content coverage, eval structure,
 * TOON compliance, dependency references, Arweave integration, and social context.
 *
 * Classification: "both" (read + write). NIP-92, NIP-94, NIP-73.
 *
 * Test IDs from test-design-epic-9.md Standard Skill Validation Template:
 *   STRUCT-A, STRUCT-B, STRUCT-C, STRUCT-D
 *   EVAL-A, EVAL-B
 *   TOON-A, TOON-B, TOON-C, TOON-D
 *   BASE-A
 *   DEP-A
 *   ARWEAVE-A
 *
 * @see _bmad-output/implementation-artifacts/9-14-media-and-files-skill.md
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve, join } from 'path';
import { parse as parseYaml } from 'yaml';

// Resolve project root (vitest runs from repo root)
const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const SKILL_DIR = join(PROJECT_ROOT, '.claude', 'skills', 'media-and-files');
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
  it('[P0] SKILL.md exists at .claude/skills/media-and-files/SKILL.md', () => {
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
    expect(frontmatter).toHaveProperty('name', 'media-and-files');
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

describe('[EVAL-A, EVAL-B] AC2: NIP-92 Coverage (Media Attachments / imeta tags)', () => {
  it('[P0] SKILL.md body covers NIP-92 and imeta tag structure', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toContain('nip-92');
    expect(lower).toContain('imeta');
    expect(lower).toMatch(/media.*attach|attach.*media/);
  });

  it('[P0] SKILL.md body covers imeta tag fields (url, m, alt, x, size, dim)', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/url/);
    expect(lower).toMatch(/mimetype|mime type|"m "/);
    expect(lower).toMatch(/alt/);
    expect(lower).toMatch(/sha.?256|"x "/);
    expect(lower).toMatch(/size/);
    expect(lower).toMatch(/dim/);
  });

  it('[P0] SKILL.md body covers optional imeta fields (blurhash, thumb, fallback)', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/blurhash/);
    expect(lower).toMatch(/thumb/);
    expect(lower).toMatch(/fallback/);
  });

  it('[P0] SKILL.md body explains multiple imeta tags per event', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/multiple.*imeta|imeta.*per event|one.*per.*url/);
  });

  it('[P0] SKILL.md body explains imeta augments existing events (kind:1, kind:30023)', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/augment|existing event|kind:1|kind:30023/);
  });

  it('[P0] nip-spec.md covers NIP-92 imeta tag format in detail', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    expect(content).toMatch(/NIP-92/);
    expect(content).toMatch(/imeta/);
    expect(content).toMatch(/\["imeta"/);
  });

  it('[P0] nip-spec.md covers imeta tag key-value format (space-separated strings)', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/space.?separated|"url |"m |"alt /);
  });
});

describe('[EVAL-A, EVAL-B] AC2: NIP-94 Coverage (File Metadata / kind:1063)', () => {
  it('[P0] SKILL.md body covers NIP-94 and kind:1063', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toContain('nip-94');
    expect(body).toMatch(/kind:1063/);
    expect(lower).toMatch(/file.*metadata/);
  });

  it('[P0] SKILL.md body covers kind:1063 as regular event', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/regular.*event|regular event/);
    expect(body).toMatch(/kind:1063/);
  });

  it('[P0] SKILL.md body covers kind:1063 required tags (url, m, x)', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/required.*tag/);
    expect(lower).toMatch(/url/);
    expect(lower).toMatch(/mime|"m"/);
    expect(lower).toMatch(/sha.?256|"x"/);
  });

  it('[P0] SKILL.md body covers kind:1063 optional tags (ox, size, dim, blurhash, thumb, image, summary, alt)', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/optional.*tag/);
    expect(lower).toMatch(/ox/);
    expect(lower).toMatch(/alt/);
  });

  it('[P0] SKILL.md body explains kind:1063 content field is description/caption', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/content.*description|content.*caption|description.*caption/);
  });

  it('[P0] nip-spec.md covers NIP-94 kind:1063 structure', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    expect(content).toMatch(/NIP-94/);
    expect(content).toMatch(/kind:1063/);
    expect(content).toMatch(/url/);
    expect(content).toMatch(/"m"/);
    expect(content).toMatch(/"x"/);
  });

  it('[P0] nip-spec.md covers kind:1063 required vs optional tags', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/required/);
    expect(lower).toMatch(/optional/);
  });
});

describe('[EVAL-A, EVAL-B] AC2: NIP-73 Coverage (External Content IDs)', () => {
  it('[P0] SKILL.md body covers NIP-73 and external content IDs', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toContain('nip-73');
    expect(lower).toMatch(/external.*content.*id|content.*id/);
  });

  it('[P0] SKILL.md body covers i tag format with type-prefixed identifiers', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/"i"/);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/type.*prefix|type:identifier/);
  });

  it('[P0] SKILL.md body covers arweave:tx: external content ID type', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/arweave:tx:/);
  });

  it('[P0] SKILL.md body covers other i tag types (isbn, doi, magnet, url)', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/isbn/);
    expect(lower).toMatch(/doi/);
  });

  it('[P0] nip-spec.md covers NIP-73 i tag format', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    expect(content).toMatch(/NIP-73/);
    expect(content).toMatch(/\["i"/);
    expect(content).toMatch(/arweave:tx:/);
  });

  it('[P0] nip-spec.md covers key i tag types (arweave:tx:, isbn:, doi:, magnet:, url:)', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    expect(content).toMatch(/arweave:tx:/);
    expect(content).toMatch(/isbn:/);
    expect(content).toMatch(/doi:/);
    expect(content).toMatch(/url:/);
  });

  it('[P0] nip-spec.md covers relay hint as optional third element in i tag', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/relay.*hint|third.*element|relay.*url/);
  });
});

describe('[EVAL-A, EVAL-B] AC2: Multi-NIP nip-spec.md Structure', () => {
  it('[P0] nip-spec.md covers all three NIPs (NIP-92, NIP-94, NIP-73)', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    expect(content).toMatch(/NIP-92/);
    expect(content).toMatch(/NIP-94/);
    expect(content).toMatch(/NIP-73/);
  });

  it('[P0] nip-spec.md has distinct sections for each NIP', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    // Each NIP should have its own section heading
    expect(content).toMatch(/#+.*NIP-92/);
    expect(content).toMatch(/#+.*NIP-94/);
    expect(content).toMatch(/#+.*NIP-73/);
  });
});

// ─── AC3: TOON Write Model [Test: TOON-A, TOON-B] ──────────────────────

describe('[TOON-A, TOON-B] AC3: TOON Write Model', () => {
  it('[P0] SKILL.md body references publishEvent() for kind:1063 file metadata', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/publishEvent\(\)/);
    expect(body).toMatch(/kind:1063/);
  });

  it('[P0] SKILL.md body references @toon-protocol/client', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/@toon-protocol\/client/);
  });

  it('[P0] SKILL.md body explains imeta tags increase event byte size and cost', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/imeta.*increase.*size|imeta.*byte.*size|imeta.*cost/);
  });

  it('[P0] SKILL.md body explains arweave:tx: in i tags adds minimal byte overhead', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/arweave.*minimal.*overhead|i.*tag.*minimal|arweave.*small/);
  });

  it('[P0] SKILL.md body references nostr-protocol-core for fee formula', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/nostr-protocol-core/);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/fee|cost|pric/);
  });

  it('[P0] SKILL.md body provides concrete fee estimates for typical media events', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/\$0\.\d+/);
    expect(lower).toMatch(/bytes/);
  });

  it('[P0] toon-extensions.md covers publishEvent flow for kind:1063', () => {
    const content = readFileSync(join(REFS_DIR, 'toon-extensions.md'), 'utf-8');
    expect(content).toMatch(/publishEvent/);
    expect(content).toMatch(/kind:1063/);
  });

  it('[P0] toon-extensions.md covers per-byte cost impact of imeta tags', () => {
    const content = readFileSync(join(REFS_DIR, 'toon-extensions.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/imeta/);
    expect(lower).toMatch(/per.?byte|basepriceperbyte/);
    expect(lower).toMatch(/cost|fee|pric/);
  });

  it('[P0] toon-extensions.md covers kind:1063 metadata event size estimates', () => {
    const content = readFileSync(join(REFS_DIR, 'toon-extensions.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/kind:1063/);
    expect(lower).toMatch(/bytes/);
    expect(lower).toMatch(/\$0\.\d+/);
  });

  it('[P0] toon-extensions.md covers imeta tag overhead per attachment', () => {
    const content = readFileSync(join(REFS_DIR, 'toon-extensions.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/imeta.*overhead|overhead.*imeta|imeta.*bytes/);
  });

  it('[P0] toon-extensions.md covers i tag external content ID byte overhead', () => {
    const content = readFileSync(join(REFS_DIR, 'toon-extensions.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/i.*tag.*byte|arweave.*overhead|external.*content.*id.*byte/);
  });

  it('[P0] scenarios.md covers media usage scenarios with publishEvent', () => {
    const content = readFileSync(join(REFS_DIR, 'scenarios.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/publishevent/);
    expect(lower).toMatch(/kind:1063/);
    expect(lower).toMatch(/imeta/);
  });

  it('[P0] scenarios.md covers attaching media to a kind:1 note', () => {
    const content = readFileSync(join(REFS_DIR, 'scenarios.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/kind:1/);
    expect(lower).toMatch(/imeta/);
    expect(lower).toMatch(/attach/);
  });

  it('[P0] scenarios.md covers creating a kind:1063 file metadata event', () => {
    const content = readFileSync(join(REFS_DIR, 'scenarios.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/kind:1063/);
    expect(lower).toMatch(/file.*metadata|metadata.*event/);
  });

  it('[P0] scenarios.md covers referencing Arweave content via i tag', () => {
    const content = readFileSync(join(REFS_DIR, 'scenarios.md'), 'utf-8');
    expect(content).toMatch(/arweave:tx:/);
    const lower = content.toLowerCase();
    expect(lower).toMatch(/i.*tag|external.*content/);
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

  it('[P0] SKILL.md body explains how to query kind:1063 file metadata events', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/query.*kind:1063|subscribe.*kind:1063|filter.*kind.*1063/);
  });

  it('[P0] SKILL.md body explains how to parse imeta tags from events', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/parse.*imeta|extract.*imeta|imeta.*pars/);
  });

  it('[P0] SKILL.md body explains i tag external content IDs as filter criteria', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/i.*tag.*filter|filter.*i.*tag|external.*content.*filter/);
  });

  it('[P0] SKILL.md body explains reading is free on TOON', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/read.*free|free.*read|reading.*free/);
  });

  it('[P0] toon-extensions.md covers TOON-format parsing for media events', () => {
    const content = readFileSync(join(REFS_DIR, 'toon-extensions.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/toon.?format/);
  });

  it('[P0] scenarios.md covers querying kind:1063 file metadata events', () => {
    const content = readFileSync(join(REFS_DIR, 'scenarios.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/query.*kind:1063|subscribe.*kind:1063|filter.*1063/);
  });

  it('[P0] scenarios.md covers parsing imeta tags from received events', () => {
    const content = readFileSync(join(REFS_DIR, 'scenarios.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/parse.*imeta|extract.*imeta|imeta.*pars/);
  });
});

// ─── AC5: Social Context [Test: STRUCT-D, TOON-D] ───────────────────────

describe('[STRUCT-D, TOON-D] AC5: Social Context', () => {
  it('[P0] SKILL.md body contains ## Social Context section', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/## Social Context/);
  });

  it('[P0] Social Context has at least 100 words of media-specific content', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const socialSection = body.split('## Social Context')[1]?.split(/\n## /)[0] || '';
    const wc = wordCount(socialSection);
    expect(wc).toBeGreaterThanOrEqual(100);
  });

  it('[P0] Social Context covers media-rich events costing more per-byte', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const socialSection = body.split('## Social Context')[1] || '';
    const lower = socialSection.toLowerCase();
    expect(lower).toMatch(/media.*cost|per.?byte|imeta.*size/);
    expect(lower).toMatch(/quality.*over.*quantity|thoughtful/);
  });

  it('[P0] Social Context covers kind:1063 metadata vs file storage distinction', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const socialSection = body.split('## Social Context')[1] || '';
    const lower = socialSection.toLowerCase();
    expect(lower).toMatch(/metadata.*small|pay.*metadata|metadata.*event/);
    expect(lower).toMatch(/external|hosted.*elsewhere/);
  });

  it('[P0] Social Context covers arweave:tx: for permanent content', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const socialSection = body.split('## Social Context')[1] || '';
    const lower = socialSection.toLowerCase();
    expect(lower).toMatch(/arweave/);
    expect(lower).toMatch(/permanent|immutable|permanence/);
  });

  it('[P0] Social Context covers alt text for accessibility', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const socialSection = body.split('## Social Context')[1] || '';
    const lower = socialSection.toLowerCase();
    expect(lower).toMatch(/alt.*text|accessibility|inclusive/);
  });

  it('[P0] Social Context covers never embedding large binary data directly', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const socialSection = body.split('## Social Context')[1] || '';
    const lower = socialSection.toLowerCase();
    expect(lower).toMatch(/never.*embed.*binary|binary.*data|bloated.*event/);
  });

  it('[P0] Social Context covers cross-platform content discovery via external IDs', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const socialSection = body.split('## Social Context')[1] || '';
    const lower = socialSection.toLowerCase();
    expect(lower).toMatch(/cross.?platform|content.*discover|isbn|doi/);
  });

  it('[P1] Social Context passes substitution test (media-specific, not generic)', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const socialSection = body.split('## Social Context')[1] || '';
    const lower = socialSection.toLowerCase();
    let specificTerms = 0;
    if (lower.match(/media/)) specificTerms++;
    if (lower.match(/imeta/)) specificTerms++;
    if (lower.match(/kind:1063/)) specificTerms++;
    if (lower.match(/arweave/)) specificTerms++;
    if (lower.match(/alt.*text|accessibility/)) specificTerms++;
    if (lower.match(/binary/)) specificTerms++;
    if (lower.match(/file.*metadata/)) specificTerms++;
    if (lower.match(/external.*content/)) specificTerms++;
    expect(specificTerms).toBeGreaterThanOrEqual(5);
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

  it('[P0] should-trigger queries cover protocol triggers (NIP-92, NIP-94, NIP-73, imeta, kind:1063)', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const shouldTrigger = evals.trigger_evals
      .filter((e: { should_trigger: boolean }) => e.should_trigger === true)
      .map((e: { query: string }) => e.query.toLowerCase());
    const joined = shouldTrigger.join(' ');
    expect(joined).toMatch(/imeta/);
    expect(joined).toMatch(/nip.?92|nip.?94|nip.?73/);
    expect(joined).toMatch(/kind:1063|file.*metadata/);
  });

  it('[P0] should-trigger queries cover social-situation triggers', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const shouldTrigger = evals.trigger_evals
      .filter((e: { should_trigger: boolean }) => e.should_trigger === true)
      .map((e: { query: string }) => e.query.toLowerCase());
    const joined = shouldTrigger.join(' ');
    expect(joined).toMatch(/how do i.*attach|how do i.*media|how do i.*file|how do i.*reference/);
  });

  it('[P0] should-trigger queries cover arweave:tx: content IDs', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const shouldTrigger = evals.trigger_evals
      .filter((e: { should_trigger: boolean }) => e.should_trigger === true)
      .map((e: { query: string }) => e.query.toLowerCase());
    const joined = shouldTrigger.join(' ');
    expect(joined).toMatch(/arweave/);
  });

  it('[P0] should-trigger queries cover at least 5 of the required media-relevant terms', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const shouldTrigger = evals.trigger_evals
      .filter((e: { should_trigger: boolean }) => e.should_trigger === true)
      .map((e: { query: string }) => e.query.toLowerCase());
    const joined = shouldTrigger.join(' ');
    let found = 0;
    const terms = [
      /nip.?92/, /nip.?94/, /nip.?73/, /imeta/,
      /kind:1063/, /media.*attach/, /file.*metadata/,
      /external.*content.*id/, /arweave/, /alt.*text/,
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

  it('[P0] should-not-trigger specifically excludes NIP-96 file storage/upload', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const shouldNotTrigger = evals.trigger_evals
      .filter((e: { should_trigger: boolean }) => e.should_trigger === false)
      .map((e: { query: string }) => e.query.toLowerCase());
    const joined = shouldNotTrigger.join(' ');
    expect(joined).toMatch(/nip.?96|upload.*file|file.*storage/);
  });

  it('[P0] should-not-trigger specifically excludes NIP-68/71 visual media events', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const shouldNotTrigger = evals.trigger_evals
      .filter((e: { should_trigger: boolean }) => e.should_trigger === false)
      .map((e: { query: string }) => e.query.toLowerCase());
    const joined = shouldNotTrigger.join(' ');
    expect(joined).toMatch(/picture.?first|visual media|nip.?68|nip.?71/);
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

  it('[P0] output evals include imeta tag structure assertion', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const allAssertions = evals.output_evals
      .flatMap((oe: { assertions: string[] }) => oe.assertions)
      .join(' ')
      .toLowerCase();
    expect(allAssertions).toMatch(/imeta/);
  });

  it('[P0] output evals include kind:1063 required tags assertion', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const allAssertions = evals.output_evals
      .flatMap((oe: { assertions: string[] }) => oe.assertions)
      .join(' ')
      .toLowerCase();
    expect(allAssertions).toMatch(/kind:1063|required.*tag/);
  });

  it('[P0] output evals include arweave:tx: format assertion', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const allAssertions = evals.output_evals
      .flatMap((oe: { assertions: string[] }) => oe.assertions)
      .join(' ')
      .toLowerCase();
    expect(allAssertions).toMatch(/arweave/);
  });

  it('[P0] output evals include fee awareness assertion', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const allAssertions = evals.output_evals
      .flatMap((oe: { assertions: string[] }) => oe.assertions)
      .join(' ')
      .toLowerCase();
    expect(allAssertions).toMatch(/fee|cost|byte/);
  });

  it('[P0] output evals include TOON-format reading assertion', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const allAssertions = evals.output_evals
      .flatMap((oe: { assertions: string[] }) => oe.assertions)
      .join(' ')
      .toLowerCase();
    expect(allAssertions).toMatch(/toon.?format/);
  });

  it('[P0] output evals include alt text accessibility assertion', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const allAssertions = evals.output_evals
      .flatMap((oe: { assertions: string[] }) => oe.assertions)
      .join(' ')
      .toLowerCase();
    expect(allAssertions).toMatch(/alt.*text|accessibility/);
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
    const writeEvals = evals.output_evals.filter(
      (oe: { id: string }) =>
        oe.id.includes('file-metadata') || oe.id.includes('media-attach') || oe.id.includes('imeta')
    );
    for (const we of writeEvals) {
      expect(we.assertions.length).toBeGreaterThanOrEqual(5);
    }
  });

  it('[P0] read-focused output evals have at least 3 assertions', () => {
    const evals = JSON.parse(readFileSync(EVALS_JSON, 'utf-8'));
    const readEvals = evals.output_evals.filter(
      (oe: { id: string }) =>
        oe.id.includes('query') || oe.id.includes('read') || oe.id.includes('discover')
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
    const bareEventPattern = /\["EVENT"\s*,/;
    expect(allContent).not.toMatch(bareEventPattern);
  });
});

describe('[TOON-B] AC7: toon-fee-check', () => {
  it('[P0] skill includes fee awareness for kind:1063 file metadata events', () => {
    const allContent = readAllSkillContent().toLowerCase();
    expect(allContent).toMatch(/per.?byte|basepriceperbyte/);
    expect(allContent).toMatch(/cost|fee|pric/);
    expect(allContent).toMatch(/kind:1063/);
  });

  it('[P0] skill includes fee awareness for imeta tag overhead', () => {
    const allContent = readAllSkillContent().toLowerCase();
    expect(allContent).toMatch(/imeta.*byte|imeta.*cost|imeta.*overhead/);
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
  it('[P0] has media-specific Social Context section (not generic)', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/## Social Context/);
    const socialSection = body.split('## Social Context')[1] || '';
    const lower = socialSection.toLowerCase();
    expect(lower).toMatch(/media|imeta|file.*metadata/);
    expect(lower).toMatch(/per.?byte|cost/);
  });
});

describe('[TOON-A/B] AC7: trigger-coverage', () => {
  it('[P0] description includes both protocol and social-situation triggers', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    // Protocol triggers
    expect(desc).toMatch(/nip.?92/);
    expect(desc).toMatch(/nip.?94/);
    expect(desc).toMatch(/nip.?73/);
    expect(desc).toMatch(/imeta/);
    expect(desc).toMatch(/kind:1063/);
    // Social-situation triggers
    expect(desc).toMatch(/how do/);
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

  it('[P0] description includes NIP-92 trigger', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    expect(desc).toMatch(/nip.?92/);
  });

  it('[P0] description includes NIP-94 trigger', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    expect(desc).toMatch(/nip.?94/);
  });

  it('[P0] description includes NIP-73 trigger', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    expect(desc).toMatch(/nip.?73/);
  });

  it('[P0] description includes media attachments trigger', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    expect(desc).toMatch(/media.*attach|attach.*media/);
  });

  it('[P0] description includes imeta tag trigger', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    expect(desc).toMatch(/imeta/);
  });

  it('[P0] description includes file metadata trigger', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    expect(desc).toMatch(/file.*metadata/);
  });

  it('[P0] description includes kind:1063 trigger', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    expect(desc).toMatch(/kind:1063/);
  });

  it('[P0] description includes external content IDs trigger', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    expect(desc).toMatch(/external.*content.*id/);
  });

  it('[P0] description includes arweave:tx: trigger', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    expect(desc).toMatch(/arweave/);
  });

  it('[P0] description includes alt text trigger', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    expect(desc).toMatch(/alt.*text/);
  });

  it('[P0] description includes MIME type trigger', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    expect(desc).toMatch(/mime/);
  });

  it('[P0] description includes SHA-256 hash trigger', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    expect(desc).toMatch(/sha.?256/);
  });

  it('[P0] description includes social-situation triggers', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    expect(desc).toMatch(/how do/);
  });

  it('[P1] description includes at least 2 media-specific social-situation phrases', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    const desc = (frontmatter.description as string).toLowerCase();
    let found = 0;
    const phrases = [
      /how do i attach media/,
      /how do i describe a file/,
      /how do i reference arweave/,
      /what is an imeta tag/,
      /how do i add alt text/,
      /how do i create a file metadata/,
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

  it('[P1] SKILL.md references long-form-content (Story 9.5) for imeta in articles', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/long-form-content/);
  });

  it('[P1] SKILL.md references content-references (Story 9.7) for URI embedding', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/content-references/);
  });

  it('[P1] SKILL.md references social-interactions (Story 9.6) for reactions to media events', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/social-interactions/);
  });

  it('[P1] SKILL.md does NOT duplicate toon-protocol-context.md into references/', () => {
    const refFiles = readdirSync(REFS_DIR);
    expect(refFiles).not.toContain('toon-protocol-context.md');
  });

  it('[P1] all five upstream skill references are present', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const deps = [
      'nostr-protocol-core',
      'nostr-social-intelligence',
      'long-form-content',
      'content-references',
      'social-interactions',
    ];
    for (const dep of deps) {
      expect(body).toContain(dep);
    }
  });
});

// ─── AC11: With/Without Baseline [Test: BASE-A] ─────────────────────────

describe('[BASE-A] AC11: With/Without Baseline', () => {
  it('[P1] SKILL.md body provides actionable media guidance (not just NIP summary)', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/publishevent/);
    expect(lower).toMatch(/per.?byte/);
    expect(lower).toMatch(/toon.?format/);
    expect(lower).toMatch(/arweave/);
  });

  it('[P1] scenarios.md provides step-by-step TOON flows (not just kind descriptions)', () => {
    const content = readFileSync(join(REFS_DIR, 'scenarios.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/step|steps/);
    expect(lower).toMatch(/publishevent/);
    expect(lower).toMatch(/fee|cost|price/);
  });
});

// ─── AC12: Arweave Integration Coverage [Test: ARWEAVE-A] ───────────────

describe('[ARWEAVE-A] AC12: Arweave Integration Coverage', () => {
  it('[P0] SKILL.md body covers arweave:tx:<txid> format in i tags', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/arweave:tx:/);
    expect(body).toMatch(/"i"/);
  });

  it('[P0] SKILL.md body covers kind:1063 referencing Arweave-hosted files via URL', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/kind:1063/);
    expect(lower).toMatch(/arweave.*url|arweave.*host|url.*arweave/);
  });

  it('[P0] SKILL.md body covers relationship between Arweave DVM (kind:5094) and NIP-73/NIP-94', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/kind:5094|arweave.*dvm|dvm.*arweave/);
    expect(lower).toMatch(/nip-73|nip-94|metadata/);
  });

  it('[P0] SKILL.md body covers arweave:tx: providing permanent/immutable content references', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    const lower = body.toLowerCase();
    expect(lower).toMatch(/arweave/);
    expect(lower).toMatch(/permanent|immutable/);
  });

  it('[P0] nip-spec.md covers arweave:tx: as key i tag type', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    expect(content).toMatch(/arweave:tx:/);
  });

  it('[P0] toon-extensions.md covers arweave:tx: in TOON context', () => {
    const content = readFileSync(join(REFS_DIR, 'toon-extensions.md'), 'utf-8');
    expect(content).toMatch(/arweave:tx:/);
    const lower = content.toLowerCase();
    expect(lower).toMatch(/permanent|immutable/);
  });

  it('[P0] scenarios.md covers Arweave content referencing scenario', () => {
    const content = readFileSync(join(REFS_DIR, 'scenarios.md'), 'utf-8');
    expect(content).toMatch(/arweave:tx:/);
    const lower = content.toLowerCase();
    expect(lower).toMatch(/arweave/);
  });

  it('[P0] toon-extensions.md documents relationship between DVM upload and NIP-73 referencing', () => {
    const content = readFileSync(join(REFS_DIR, 'toon-extensions.md'), 'utf-8');
    const lower = content.toLowerCase();
    expect(lower).toMatch(/kind:5094|dvm.*upload|upload.*dvm/);
    expect(lower).toMatch(/arweave:tx:/);
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

// ─── Cross-cutting: imeta Tag Consistency ───────────────────────────────

describe('imeta Tag Cross-File Consistency', () => {
  it('[P0] imeta tag is documented consistently across SKILL.md and nip-spec.md', () => {
    const skillContent = readFileSync(SKILL_MD, 'utf-8');
    const nipSpec = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    expect(skillContent).toMatch(/imeta/);
    expect(nipSpec).toMatch(/imeta/);
    expect(skillContent).toMatch(/\["imeta"/);
    expect(nipSpec).toMatch(/\["imeta"/);
  });

  it('[P0] imeta tag is mentioned in scenarios.md for media attachment operations', () => {
    const content = readFileSync(join(REFS_DIR, 'scenarios.md'), 'utf-8');
    expect(content).toMatch(/imeta/);
  });

  it('[P0] imeta tag is mentioned in toon-extensions.md for cost analysis', () => {
    const content = readFileSync(join(REFS_DIR, 'toon-extensions.md'), 'utf-8');
    expect(content).toMatch(/imeta/);
    const lower = content.toLowerCase();
    expect(lower).toMatch(/cost|fee|byte/);
  });
});

// ─── Cross-cutting: kind:1063 Consistency ────────────────────────────────

describe('kind:1063 Cross-File Consistency', () => {
  it('[P0] kind:1063 documented in SKILL.md', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    const { body } = parseFrontmatter(content);
    expect(body).toMatch(/kind:1063/);
  });

  it('[P0] kind:1063 documented in nip-spec.md', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    expect(content).toMatch(/kind:1063/);
  });

  it('[P0] kind:1063 documented in toon-extensions.md', () => {
    const content = readFileSync(join(REFS_DIR, 'toon-extensions.md'), 'utf-8');
    expect(content).toMatch(/kind:1063/);
  });

  it('[P0] kind:1063 referenced in scenarios.md', () => {
    const content = readFileSync(join(REFS_DIR, 'scenarios.md'), 'utf-8');
    expect(content).toMatch(/kind:1063/);
  });
});

// ─── Cross-cutting: Arweave Cross-File Consistency ──────────────────────

describe('Arweave Cross-File Consistency', () => {
  it('[P0] arweave:tx: referenced in SKILL.md', () => {
    const content = readFileSync(SKILL_MD, 'utf-8');
    expect(content).toMatch(/arweave:tx:/);
  });

  it('[P0] arweave:tx: referenced in nip-spec.md', () => {
    const content = readFileSync(join(REFS_DIR, 'nip-spec.md'), 'utf-8');
    expect(content).toMatch(/arweave:tx:/);
  });

  it('[P0] arweave:tx: referenced in toon-extensions.md', () => {
    const content = readFileSync(join(REFS_DIR, 'toon-extensions.md'), 'utf-8');
    expect(content).toMatch(/arweave:tx:/);
  });

  it('[P0] arweave:tx: referenced in scenarios.md', () => {
    const content = readFileSync(join(REFS_DIR, 'scenarios.md'), 'utf-8');
    expect(content).toMatch(/arweave:tx:/);
  });
});

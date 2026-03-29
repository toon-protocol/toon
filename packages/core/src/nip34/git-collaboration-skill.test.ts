/**
 * ATDD tests for Story 9.26: NIP-34 Kind Resources Skill -- Git Collaboration
 *
 * Test IDs: 9.26-UNIT-001 through 9.26-UNIT-012
 *
 * AC covered:
 * - AC #1: SKILL.md exists with valid YAML frontmatter and under 500 lines
 * - AC #2: SKILL.md covers all 11 NIP-34 event kinds plus kind:5094 (12 total)
 * - AC #3: Each event kind has its own Level 3 resource file in references/
 * - AC #4: references/nip-spec.md contains consolidated NIP-34 specification
 * - AC #5: references/toon-extensions.md documents TOON write/read model
 * - AC #6: references/scenarios.md provides social context scenarios
 * - AC #7: evals/evals.json contains trigger and output evals
 * - AC #8: All resource files use imperative form and follow skill-creator anatomy
 * - AC #9: SKILL.md description is 80-120 words with social-situation triggers
 * - AC #10: SKILL.md includes "When to read each reference" section mapping all files
 * - AC #11: SKILL.md includes Social Context section for paid git collaboration
 * - AC #12: All event kind resource files document required structural elements
 *
 * TDD Phase: RED -- All tests fail until skill files are created.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

// ============================================================================
// Test Helpers
// ============================================================================

const PROJECT_ROOT = resolve(__dirname, '../../../../');
const SKILL_DIR = join(PROJECT_ROOT, '.claude/skills/git-collaboration');
const REFS_DIR = join(SKILL_DIR, 'references');
const EVALS_DIR = join(SKILL_DIR, 'evals');
const SKILL_MD = join(SKILL_DIR, 'SKILL.md');

/**
 * All NIP-34 event kinds that must be covered.
 */
const NIP34_KINDS = [
  {
    kind: 30617,
    name: 'Repository Announcement',
    file: 'kind-30617-repository-announcement.md',
  },
  {
    kind: 30618,
    name: 'Repository State',
    file: 'kind-30618-repository-state.md',
  },
  { kind: 1617, name: 'Patch', file: 'kind-1617-patch.md' },
  { kind: 1618, name: 'Pull Request', file: 'kind-1618-pull-request.md' },
  {
    kind: 1619,
    name: 'PR Status Update',
    file: 'kind-1619-pr-status-update.md',
  },
  { kind: 1621, name: 'Issue', file: 'kind-1621-issue.md' },
  { kind: 1622, name: 'Reply/Comment', file: 'kind-1622-reply.md' },
  { kind: 1630, name: 'Status Open', file: 'kind-1630-status-open.md' },
  { kind: 1631, name: 'Status Applied', file: 'kind-1631-status-applied.md' },
  { kind: 1632, name: 'Status Closed', file: 'kind-1632-status-closed.md' },
  { kind: 1633, name: 'Status Draft', file: 'kind-1633-status-draft.md' },
  { kind: 5094, name: 'Blob Storage DVM', file: 'kind-5094-blob-storage.md' },
] as const;

/**
 * Major kind categories that must each have at least one output eval.
 */
const MAJOR_KIND_CATEGORIES = [
  'repo',
  'patch',
  'pr',
  'issue',
  'reply',
  'status',
  'blob',
];

/**
 * Safely read a file, returning empty string if it does not exist.
 */
function safeRead(filePath: string): string {
  if (!existsSync(filePath)) return '';
  return readFileSync(filePath, 'utf-8');
}

/**
 * Count non-empty lines in a string.
 */
function countLines(content: string): number {
  return content.split('\n').length;
}

/**
 * Count words in a string.
 */
function countWords(text: string): number {
  return text
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
}

/**
 * Extract YAML frontmatter from markdown content.
 * Returns the YAML block between --- delimiters, or null.
 */
function extractFrontmatter(content: string): string | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  return match ? match[1] : null;
}

/**
 * Extract the description field from YAML frontmatter.
 */
function extractDescription(frontmatter: string): string {
  // Handle multi-line or single-line description
  const singleLine = frontmatter.match(/^description:\s*['"]?(.*?)['"]?\s*$/m);
  if (singleLine) return singleLine[1];

  const multiLine = frontmatter.match(
    /^description:\s*[|>]-?\s*\n([\s\S]*?)(?=^\w|$)/m
  );
  if (multiLine) {
    return multiLine[1]
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .join(' ');
  }
  return '';
}

// ============================================================================
// 9.26-UNIT-001: SKILL.md Existence and Frontmatter (AC #1)
// ============================================================================

describe('Git Collaboration Skill Structure (Story 9.26)', () => {
  describe('SKILL.md existence and frontmatter (9.26-UNIT-001, AC #1)', () => {
    it('[P0] SKILL.md exists at .claude/skills/git-collaboration/SKILL.md', () => {
      // Arrange & Act
      const exists = existsSync(SKILL_MD);

      // Assert
      expect(exists).toBe(true);
    });

    it('[P0] SKILL.md has valid YAML frontmatter with --- delimiters', () => {
      // Arrange
      const content = safeRead(SKILL_MD);

      // Act
      const frontmatter = extractFrontmatter(content);

      // Assert
      expect(frontmatter).not.toBeNull();
    });

    it('[P0] SKILL.md frontmatter contains name field set to "git-collaboration"', () => {
      // Arrange
      const content = safeRead(SKILL_MD);
      const frontmatter = extractFrontmatter(content);

      // Assert
      expect(frontmatter).not.toBeNull();
      expect(frontmatter).toMatch(/^name:\s*['"]?git-collaboration['"]?\s*$/m);
    });

    it('[P0] SKILL.md frontmatter contains description field', () => {
      // Arrange
      const content = safeRead(SKILL_MD);
      const frontmatter = extractFrontmatter(content);

      // Assert
      expect(frontmatter).not.toBeNull();
      expect(frontmatter).toMatch(/^description:/m);
    });

    it('[P0] SKILL.md frontmatter has ONLY name and description fields', () => {
      // Arrange
      const content = safeRead(SKILL_MD);
      const frontmatter = extractFrontmatter(content);

      // Act -- extract top-level keys (lines starting with a word followed by colon)
      const keys = (frontmatter ?? '')
        .split('\n')
        .filter((line) => /^\w[\w-]*:/.test(line))
        .map((line) => line.split(':')[0]);

      // Assert
      expect(keys.sort()).toEqual(['description', 'name']);
    });

    it('[P0] SKILL.md is under 500 lines', () => {
      // Arrange
      const content = safeRead(SKILL_MD);
      expect(content).not.toBe(''); // Guard: file must exist and have content

      // Act
      const lines = countLines(content);

      // Assert
      expect(lines).toBeLessThan(500);
    });
  });

  // ============================================================================
  // 9.26-UNIT-002: SKILL.md Covers All Event Kinds (AC #2)
  // ============================================================================

  describe('SKILL.md covers all 12 event kinds (9.26-UNIT-002, AC #2)', () => {
    const content = safeRead(SKILL_MD);

    it.each(NIP34_KINDS)(
      '[P0] SKILL.md mentions kind:$kind ($name)',
      ({ kind }) => {
        expect(content).toMatch(new RegExp(`${kind}`));
      }
    );

    it('[P0] SKILL.md mentions all 11 NIP-34 kinds plus kind:5094', () => {
      // Arrange
      const allKinds = NIP34_KINDS.map((k) => k.kind);

      // Act
      const mentionedKinds = allKinds.filter((kind) =>
        content.includes(String(kind))
      );

      // Assert
      expect(mentionedKinds).toHaveLength(12);
    });
  });

  // ============================================================================
  // 9.26-UNIT-003: Per-Kind Resource Files (AC #3)
  // ============================================================================

  describe('Per-kind resource files exist (9.26-UNIT-003, AC #3)', () => {
    it.each(NIP34_KINDS)(
      '[P0] references/$file exists for kind:$kind ($name)',
      ({ file }) => {
        const filePath = join(REFS_DIR, file);
        expect(existsSync(filePath)).toBe(true);
      }
    );
  });

  // ============================================================================
  // 9.26-UNIT-004: NIP Spec Reference (AC #4)
  // ============================================================================

  describe('references/nip-spec.md (9.26-UNIT-004, AC #4)', () => {
    it('[P0] references/nip-spec.md exists', () => {
      expect(existsSync(join(REFS_DIR, 'nip-spec.md'))).toBe(true);
    });

    it('[P1] nip-spec.md contains consolidated NIP-34 specification content', () => {
      const content = safeRead(join(REFS_DIR, 'nip-spec.md'));

      // Must mention NIP-34 and contain event kind descriptions
      expect(content).toMatch(/NIP-34/i);
      expect(content).toMatch(/30617/);
      expect(content).toMatch(/1617/);
    });
  });

  // ============================================================================
  // 9.26-UNIT-005: TOON Extensions Reference (AC #5)
  // ============================================================================

  describe('references/toon-extensions.md (9.26-UNIT-005, AC #5)', () => {
    it('[P0] references/toon-extensions.md exists', () => {
      expect(existsSync(join(REFS_DIR, 'toon-extensions.md'))).toBe(true);
    });

    it('[P1] toon-extensions.md documents TOON write model', () => {
      const content = safeRead(join(REFS_DIR, 'toon-extensions.md'));
      // Must cover publishEvent, fee calculation, per-byte pricing
      expect(content).toMatch(/publishEvent|write.*model/i);
      expect(content).toMatch(/fee|basePricePerByte|per.byte/i);
    });

    it('[P1] toon-extensions.md documents TOON read model', () => {
      const content = safeRead(join(REFS_DIR, 'toon-extensions.md'));
      // Must cover TOON-format responses, decoder usage
      expect(content).toMatch(/read.*model|TOON.format|decoder/i);
    });

    it('[P1] toon-extensions.md documents ILP considerations', () => {
      const content = safeRead(join(REFS_DIR, 'toon-extensions.md'));
      expect(content).toMatch(/ILP|Interledger/i);
    });
  });

  // ============================================================================
  // 9.26-UNIT-006: Scenarios Reference (AC #6)
  // ============================================================================

  describe('references/scenarios.md (9.26-UNIT-006, AC #6)', () => {
    it('[P0] references/scenarios.md exists', () => {
      expect(existsSync(join(REFS_DIR, 'scenarios.md'))).toBe(true);
    });

    it('[P1] scenarios.md provides social context for git collaboration on paid network', () => {
      const content = safeRead(join(REFS_DIR, 'scenarios.md'));
      expect(content).toMatch(/paid|cost|fee|ILP/i);
      expect(content).toMatch(/git|repository|patch|pull.request|issue/i);
    });
  });

  // ============================================================================
  // 9.26-UNIT-007: Evals JSON (AC #7)
  // ============================================================================

  describe('evals/evals.json (9.26-UNIT-007, AC #7)', () => {
    it('[P0] evals/evals.json exists', () => {
      expect(existsSync(join(EVALS_DIR, 'evals.json'))).toBe(true);
    });

    it('[P0] evals/evals.json is valid JSON', () => {
      const content = safeRead(join(EVALS_DIR, 'evals.json'));
      expect(() => JSON.parse(content)).not.toThrow();
    });

    it('[P0] evals.json has 8-10 should_trigger:true evals', () => {
      // Arrange
      const content = safeRead(join(EVALS_DIR, 'evals.json'));
      if (!content) {
        expect(content).not.toBe('');
        return;
      }
      const evals = JSON.parse(content);

      // Act
      const triggerTrue = (evals.trigger_evals ?? evals).filter(
        (e: { should_trigger?: boolean }) => e.should_trigger === true
      );

      // Assert
      expect(triggerTrue.length).toBeGreaterThanOrEqual(8);
      expect(triggerTrue.length).toBeLessThanOrEqual(10);
    });

    it('[P0] evals.json has 8-10 should_trigger:false evals', () => {
      // Arrange
      const content = safeRead(join(EVALS_DIR, 'evals.json'));
      if (!content) {
        expect(content).not.toBe('');
        return;
      }
      const evals = JSON.parse(content);

      // Act
      const triggerFalse = (evals.trigger_evals ?? evals).filter(
        (e: { should_trigger?: boolean }) => e.should_trigger === false
      );

      // Assert
      expect(triggerFalse.length).toBeGreaterThanOrEqual(8);
      expect(triggerFalse.length).toBeLessThanOrEqual(10);
    });

    it('[P0] evals.json has 6-12 output evals with rubrics', () => {
      // Arrange
      const content = safeRead(join(EVALS_DIR, 'evals.json'));
      if (!content) {
        expect(content).not.toBe('');
        return;
      }
      const evals = JSON.parse(content);

      // Act
      const outputEvals = evals.output_evals ?? [];

      // Assert
      expect(outputEvals.length).toBeGreaterThanOrEqual(6);
      expect(outputEvals.length).toBeLessThanOrEqual(12);

      // Each output eval must have a rubric
      for (const evalItem of outputEvals) {
        expect(evalItem).toHaveProperty('rubric');
      }
    });

    it('[P1] output evals cover all major kind categories', () => {
      // Arrange
      const content = safeRead(join(EVALS_DIR, 'evals.json'));
      if (!content) {
        expect(content).not.toBe('');
        return;
      }
      const evals = JSON.parse(content);
      const outputEvals = evals.output_evals ?? [];

      // Act -- check that at least one output eval relates to each category
      const evalText = JSON.stringify(outputEvals).toLowerCase();

      // Assert -- each major category must appear somewhere in the output evals
      for (const category of MAJOR_KIND_CATEGORIES) {
        expect(evalText).toContain(category);
      }
    });
  });

  // ============================================================================
  // 9.26-UNIT-008: Imperative Form and Skill Anatomy (AC #8)
  // ============================================================================

  describe('Skill anatomy and imperative form (9.26-UNIT-008, AC #8)', () => {
    it('[P1] SKILL.md body does not start with "This skill" or similar passive phrasing', () => {
      // Arrange
      const content = safeRead(SKILL_MD);
      expect(content).not.toBe(''); // Guard: file must exist and have content
      // Remove frontmatter
      const body = content.replace(/^---[\s\S]*?---\n/, '').trim();
      expect(body.length).toBeGreaterThan(0); // Guard: body must have content

      // Assert -- imperative form should not start with "This skill..."
      expect(body).not.toMatch(/^This skill/i);
    });

    it.each(NIP34_KINDS)(
      '[P2] references/$file uses imperative form (no "This file" opener)',
      ({ file }) => {
        const content = safeRead(join(REFS_DIR, file));
        if (!content) {
          expect(content).not.toBe('');
          return;
        }
        // Remove any frontmatter or heading
        const body = content.replace(/^#.*\n/, '').trim();
        expect(body).not.toMatch(/^This file/i);
      }
    );
  });

  // ============================================================================
  // 9.26-UNIT-009: Description Word Count (AC #9)
  // ============================================================================

  describe('SKILL.md description word count (9.26-UNIT-009, AC #9)', () => {
    it('[P0] SKILL.md description is 80-120 words', () => {
      // Arrange
      const content = safeRead(SKILL_MD);
      const frontmatter = extractFrontmatter(content);
      if (!frontmatter) {
        expect(frontmatter).not.toBeNull();
        return;
      }

      // Act
      const description = extractDescription(frontmatter);
      const wordCount = countWords(description);

      // Assert
      expect(wordCount).toBeGreaterThanOrEqual(80);
      expect(wordCount).toBeLessThanOrEqual(120);
    });

    it('[P1] SKILL.md description contains social-situation triggers', () => {
      // Arrange
      const content = safeRead(SKILL_MD);
      const frontmatter = extractFrontmatter(content);
      if (!frontmatter) {
        expect(frontmatter).not.toBeNull();
        return;
      }
      const description = extractDescription(frontmatter);

      // Assert -- should contain question-like social triggers
      // e.g., "how do I...", "should I...", "what is the cost of..."
      const hasSocialTriggers =
        /how do I|should I|what.*cost|when.*should|is it worth/i.test(
          description
        );
      expect(hasSocialTriggers).toBe(true);
    });
  });

  // ============================================================================
  // 9.26-UNIT-010: When to Read Each Reference Section (AC #10)
  // ============================================================================

  describe('When to read each reference section (9.26-UNIT-010, AC #10)', () => {
    it('[P0] SKILL.md contains a "When to read each reference" section', () => {
      const content = safeRead(SKILL_MD);
      expect(content).toMatch(/when to read each reference/i);
    });

    it('[P0] "When to read" section maps all 12 kind resource files', () => {
      const content = safeRead(SKILL_MD);

      for (const { file } of NIP34_KINDS) {
        expect(content).toContain(file);
      }
    });

    it('[P0] "When to read" section maps nip-spec.md, toon-extensions.md, and scenarios.md', () => {
      const content = safeRead(SKILL_MD);
      expect(content).toContain('nip-spec.md');
      expect(content).toContain('toon-extensions.md');
      expect(content).toContain('scenarios.md');
    });
  });

  // ============================================================================
  // 9.26-UNIT-011: Social Context Section (AC #11)
  // ============================================================================

  describe('Social Context section (9.26-UNIT-011, AC #11)', () => {
    it('[P0] SKILL.md includes a Social Context section', () => {
      const content = safeRead(SKILL_MD);
      expect(content).toMatch(/social context/i);
    });

    it('[P1] Social Context section is specific to paid git collaboration', () => {
      const content = safeRead(SKILL_MD);

      // Must mention git-specific concepts AND paid network concepts together
      expect(content).toMatch(/git|repository|patch|pull.request/i);
      expect(content).toMatch(/paid|cost|fee|per.byte/i);
    });
  });

  // ============================================================================
  // 9.26-UNIT-012: Event Kind Resource File Structural Elements (AC #12)
  // ============================================================================

  describe('Event kind resource file structural elements (9.26-UNIT-012, AC #12)', () => {
    it.each(NIP34_KINDS)(
      '[P0] references/$file documents event structure (JSON example)',
      ({ file }) => {
        const content = safeRead(join(REFS_DIR, file));
        if (!content) {
          expect(content).not.toBe('');
          return;
        }
        // Must contain a JSON code block showing event structure
        expect(content).toMatch(/```json/);
        expect(content).toMatch(/"kind"/);
      }
    );

    it.each(NIP34_KINDS)(
      '[P1] references/$file documents required and optional tags',
      ({ file }) => {
        const content = safeRead(join(REFS_DIR, file));
        if (!content) {
          expect(content).not.toBe('');
          return;
        }
        expect(content).toMatch(/required|optional/i);
        expect(content).toMatch(/tag/i);
      }
    );

    it.each(NIP34_KINDS)(
      '[P1] references/$file documents content format',
      ({ file }) => {
        const content = safeRead(join(REFS_DIR, file));
        if (!content) {
          expect(content).not.toBe('');
          return;
        }
        expect(content).toMatch(/content/i);
      }
    );

    it.each(NIP34_KINDS)(
      '[P1] references/$file documents filter patterns',
      ({ file }) => {
        const content = safeRead(join(REFS_DIR, file));
        if (!content) {
          expect(content).not.toBe('');
          return;
        }
        expect(content).toMatch(/filter/i);
      }
    );

    it.each(NIP34_KINDS)(
      '[P1] references/$file documents typical byte size',
      ({ file }) => {
        const content = safeRead(join(REFS_DIR, file));
        if (!content) {
          expect(content).not.toBe('');
          return;
        }
        expect(content).toMatch(/byte/i);
      }
    );

    it.each(NIP34_KINDS)(
      '[P1] references/$file documents TOON fee estimates',
      ({ file }) => {
        const content = safeRead(join(REFS_DIR, file));
        if (!content) {
          expect(content).not.toBe('');
          return;
        }
        expect(content).toMatch(/fee|\$\d|basePricePerByte/i);
      }
    );
  });
});

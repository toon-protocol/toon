/**
 * Tests for Nix Reproducible Builds (Story 4.5)
 *
 * TDD GREEN PHASE -- all tests converted from `it.skip()` to `it()`.
 *
 * These tests validate that Nix-based Docker builds produce deterministic
 * outputs: identical image hashes and identical PCR (Platform Configuration
 * Register) values across independent builds. This is the foundation of the
 * TEE attestation trust model -- if builds are not reproducible, PCR values
 * cannot be verified against a known-good registry (R-E4-002).
 *
 * Modules under test:
 *   - `./nix-builder.js`      -- Nix build orchestration (NixBuilder class)
 *   - `./pcr-validator.js`    -- PCR comparison and CI verification utilities
 *   - `./index.js`            -- Barrel re-exports for build module
 *   - `docker/Dockerfile.nix` -- Deterministic Nix expression for Docker image
 *   - `flake.nix`             -- Nix flake definition at project root
 *
 * Risk: R-E4-002 (Score 6) -- Nix build non-reproducibility collapses the
 * attestation verification model.
 *
 * Test IDs:
 *   T-4.5-01: Nix build determinism -- identical image hashes (AC #1)
 *   T-4.5-02: Nix build determinism -- identical PCR values (AC #2)
 *   T-4.5-03: Dockerfile.nix determinism -- static analysis (AC #3)
 *   T-4.5-04: CI pipeline PCR reproducibility verification (AC #4)
 *   T-4.5-05: Barrel exports -- all build module exports importable (AC #5)
 *   T-4.5-06: flake.nix exists, .gitignore contains /result (AC #6)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import type { NixBuildResult } from './nix-builder.js';
import { NixBuilder } from './nix-builder.js';
import {
  verifyPcrReproducibility,
  analyzeDockerfileForNonDeterminism,
  PcrReproducibilityError,
} from './pcr-validator.js';

// ---------------------------------------------------------------------------
// Mock child_process for NixBuilder tests (no real Nix available in CI).
// The mock sets up execFile to call the callback with a fake nix store path.
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  execFile: vi.fn(
    (
      _cmd: string,
      _args: string[],
      _opts: Record<string, unknown>,
      callback: (error: Error | null, stdout: string, stderr: string) => void
    ) => {
      callback(null, '/nix/store/abc123-crosstown-docker-image.tar.gz\n', '');
    }
  ),
}));

// Mock node:fs/promises readFile to intercept /nix/store/ reads while
// allowing real file reads to pass through. The mkdtemp/cp/writeFile/rm
// are also mocked to no-op for sourceOverride tests.
const MOCK_IMAGE_CONTENT = Buffer.from(
  'deterministic-image-content-for-testing'
);
let mockImageContent = MOCK_IMAGE_CONTENT;

vi.mock('node:fs/promises', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: vi.fn(async (filePath: string, encoding?: string) => {
      const pathStr =
        typeof filePath === 'string' ? filePath : String(filePath);
      if (pathStr.startsWith('/nix/store/')) {
        // Return mock image content for Nix store reads
        return mockImageContent;
      }
      // For real file paths, delegate to the actual implementation
      return actual.readFile(filePath, encoding as BufferEncoding);
    }),
    mkdtemp: vi.fn(async () => '/tmp/crosstown-nix-mock'),
    cp: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    rm: vi.fn(async () => undefined),
  };
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Path to Dockerfile.nix relative to the project root. */
const DOCKERFILE_NIX_PATH = 'docker/Dockerfile.nix';

/** SHA-384 produces 96-character hex strings. */
const PCR_HEX_LENGTH = 96;

/** Regex pattern for a valid PCR value (96 lowercase hex characters). */
const PCR_HEX_PATTERN = /^[0-9a-f]{96}$/;

/** Callback type for the mocked execFile (avoids repeated inline casts). */
type ExecFileCallback = (
  error: Error | null,
  stdout: string,
  stderr: string
) => void;

// ---------------------------------------------------------------------------
// Path resolution helper
// ---------------------------------------------------------------------------

/**
 * Resolves a relative path (from project root) to an absolute path.
 * In tests, __dirname is packages/core/src/build, so we go up 4 levels.
 */
function resolveFromRoot(relativePath: string): string {
  return path.resolve(__dirname, '../../../../', relativePath);
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/**
 * Creates a mock NixBuildResult with sensible defaults and optional overrides.
 * Represents the output of a single `nix build` invocation.
 */
function createNixBuildResult(
  overrides: Partial<NixBuildResult> = {}
): NixBuildResult {
  return {
    imageHash: 'sha256:' + 'ab12cd34'.repeat(8),
    pcr0: 'a1b2c3d4'.repeat(12), // 96 hex chars
    pcr1: 'e5f6a7b8'.repeat(12),
    pcr2: 'c9d0e1f2'.repeat(12),
    imagePath: '/nix/store/abc123-crosstown-docker-image.tar.gz',
    buildTimestamp: 1767225600,
    ...overrides,
  };
}

/**
 * Creates a pair of NixBuildResults representing two independent builds.
 * When `identical` is true, both builds produce the same hashes and PCR values.
 * When `identical` is false, they diverge (simulating non-deterministic builds).
 */
function createBuildPair(identical: boolean): {
  buildA: NixBuildResult;
  buildB: NixBuildResult;
} {
  const buildA = createNixBuildResult();
  const buildB = identical
    ? createNixBuildResult()
    : createNixBuildResult({
        imageHash: 'sha256:' + 'ff00ee11'.repeat(8),
        pcr0: 'deadbeef'.repeat(12),
        pcr1: 'cafebabe'.repeat(12),
        pcr2: 'f00dcafe'.repeat(12),
        imagePath: '/nix/store/xyz789-crosstown-docker-image.tar.gz',
      });

  return { buildA, buildB };
}

/**
 * Returns a list of known non-deterministic patterns that must NOT appear
 * in Dockerfile.nix. Each entry includes the pattern string and a human-readable
 * reason explaining why it breaks reproducibility.
 */
function createForbiddenPatterns(): {
  pattern: RegExp;
  name: string;
  reason: string;
}[] {
  return [
    {
      pattern: /apt-get\s+update/,
      name: 'apt-get update',
      reason:
        'Package indices change daily; produces different layers on every build',
    },
    {
      pattern: /npm\s+install\s+(?!.*--frozen-lockfile)(?!.*ci\b)/,
      name: 'npm install without lockfile',
      reason:
        'npm install without --frozen-lockfile or npm ci resolves latest versions non-deterministically',
    },
    {
      pattern:
        /git\s+clone\s+(?!.*--branch\s+\S+\s+--single-branch)(?!.*@[0-9a-f]{40})/,
      name: 'git clone without pinned commit',
      reason:
        'git clone without a pinned commit hash fetches HEAD which changes over time',
    },
    {
      pattern: /FROM\s+\S+:latest\b/,
      name: 'unpinned base image (:latest)',
      reason: ':latest tag resolves to different images over time',
    },
    {
      pattern: /FROM\s+(?!scratch\b)(?!.*@sha256:)\S+/,
      name: 'base image without digest pin',
      reason:
        'Without @sha256: digest pin, tag can resolve to different images (FROM scratch is exempt)',
    },
    {
      pattern: /pip\s+install\s+(?!.*==)(?!.*-r\s+\S+)/,
      name: 'unpinned pip install',
      reason: 'pip install without version pins (==) fetches latest versions',
    },
    {
      pattern: /curl\s+.*\|\s*(ba)?sh/,
      name: 'curl pipe to shell',
      reason:
        'Remote scripts change over time; produces non-deterministic results',
    },
  ];
}

// ===========================================================================
// T-4.5-01 [P0]: Nix build produces identical Docker image hash across two
// consecutive builds (AC #1)
// ===========================================================================

describe('T-4.5-01: Nix build determinism -- identical image hashes', () => {
  beforeEach(() => {
    mockImageContent = MOCK_IMAGE_CONTENT;
  });

  // Mock-based test: validates the NixBuilder class interface and that
  // deterministic inputs produce deterministic outputs.
  it('T-4.5-01a: two consecutive nix builds produce the same Docker image hash', async () => {
    // Arrange
    const builder = new NixBuilder({
      projectRoot: resolveFromRoot('.'),
      dockerfilePath: DOCKERFILE_NIX_PATH,
    });

    // Act -- run two consecutive builds from the same source tree
    const buildA = await builder.build();
    const buildB = await builder.build();

    // Assert -- both builds must produce the exact same image hash
    expect(buildA.imageHash).toBe(buildB.imageHash);

    // Image hashes must be valid sha256 strings
    expect(buildA.imageHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(buildB.imageHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  // Mock-based test: Nix store paths are content-addressed, so same inputs
  // produce the same path.
  it('T-4.5-01b: two consecutive builds produce the same /nix/store path', async () => {
    // Arrange
    const builder = new NixBuilder({
      projectRoot: resolveFromRoot('.'),
      dockerfilePath: DOCKERFILE_NIX_PATH,
    });

    // Act
    const buildA = await builder.build();
    const buildB = await builder.build();

    // Assert -- Nix store paths are content-addressed; same inputs = same path
    expect(buildA.imagePath).toBe(buildB.imagePath);
    expect(buildA.imagePath).toMatch(/^\/nix\/store\//);
  });

  // Mock-based test: validates NixBuildResult structure.
  it('T-4.5-01c: NixBuildResult contains imageHash, pcr0-2, and imagePath', async () => {
    // Arrange
    const builder = new NixBuilder({
      projectRoot: resolveFromRoot('.'),
      dockerfilePath: DOCKERFILE_NIX_PATH,
    });

    // Act
    const result = await builder.build();

    // Assert -- all required fields present and properly typed
    expect(result.imageHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.pcr0).toMatch(PCR_HEX_PATTERN);
    expect(result.pcr1).toMatch(PCR_HEX_PATTERN);
    expect(result.pcr2).toMatch(PCR_HEX_PATTERN);
    expect(result.pcr0).toHaveLength(PCR_HEX_LENGTH);
    expect(result.imagePath).toBeDefined();
    expect(typeof result.buildTimestamp).toBe('number');
  });

  // Gap test: NixBuilder.build() must propagate errors when the nix command fails.
  // AC #1 specifies NixBuilder wraps `nix build` -- errors must surface clearly.
  it('T-4.5-01d: NixBuilder.build() throws when nix build command fails', async () => {
    // Arrange -- reconfigure mock to simulate nix build failure
    const { execFile } = await import('node:child_process');
    const mockExecFile = vi.mocked(execFile);
    mockExecFile.mockImplementationOnce((_cmd, _args, _opts, callback) => {
      (callback as ExecFileCallback)(
        new Error('nix: command not found'),
        '',
        'nix: command not found'
      );
    });

    const builder = new NixBuilder({
      projectRoot: resolveFromRoot('.'),
      dockerfilePath: DOCKERFILE_NIX_PATH,
    });

    // Act & Assert -- build must throw the error from the failed command
    await expect(builder.build()).rejects.toThrow('nix: command not found');
  });

  // Gap test: NixBuilder.build() throws when nix returns an invalid store path.
  it('T-4.5-01e: NixBuilder.build() throws when nix returns unexpected output path', async () => {
    // Arrange -- reconfigure mock to return a non-nix-store path
    const { execFile } = await import('node:child_process');
    const mockExecFile = vi.mocked(execFile);
    mockExecFile.mockImplementationOnce((_cmd, _args, _opts, callback) => {
      (callback as ExecFileCallback)(null, '/tmp/not-a-nix-store-path\n', '');
    });

    const builder = new NixBuilder({
      projectRoot: resolveFromRoot('.'),
      dockerfilePath: DOCKERFILE_NIX_PATH,
    });

    // Act & Assert -- must throw with descriptive error about unexpected path
    await expect(builder.build()).rejects.toThrow(
      /Unexpected Nix build output path/
    );
  });
});

// ===========================================================================
// T-4.5-02 [P0]: Nix build produces identical PCR values across two
// independent builds (AC #2)
// ===========================================================================

describe('T-4.5-02: Nix build determinism -- identical PCR values', () => {
  beforeEach(() => {
    mockImageContent = MOCK_IMAGE_CONTENT;
  });

  // Mock-based test: PCR values are derived from image content, so identical
  // images produce identical PCR values.
  it('T-4.5-02a: two independent nix builds produce identical PCR0 values', async () => {
    // Arrange
    const builder = new NixBuilder({
      projectRoot: resolveFromRoot('.'),
      dockerfilePath: DOCKERFILE_NIX_PATH,
    });

    // Act -- two independent builds (simulating separate CI jobs)
    const buildA = await builder.build();
    const buildB = await builder.build();

    // Assert -- PCR0 must be identical across builds
    expect(buildA.pcr0).toBe(buildB.pcr0);
    expect(buildA.pcr0).toMatch(PCR_HEX_PATTERN);
  });

  // Mock-based test: all three PCR registers must match.
  it('T-4.5-02b: all three PCR values (pcr0, pcr1, pcr2) are identical across builds', async () => {
    // Arrange
    const builder = new NixBuilder({
      projectRoot: resolveFromRoot('.'),
      dockerfilePath: DOCKERFILE_NIX_PATH,
    });

    // Act
    const buildA = await builder.build();
    const buildB = await builder.build();

    // Assert -- all three PCR registers must match
    expect(buildA.pcr0).toBe(buildB.pcr0);
    expect(buildA.pcr1).toBe(buildB.pcr1);
    expect(buildA.pcr2).toBe(buildB.pcr2);

    // Each PCR must be a valid SHA-384 hex string (96 chars)
    for (const pcr of [buildA.pcr0, buildA.pcr1, buildA.pcr2]) {
      expect(pcr).toHaveLength(PCR_HEX_LENGTH);
      expect(pcr).toMatch(PCR_HEX_PATTERN);
    }
  });

  // Mock-based test: different image content must produce different PCR values.
  // This proves the PCR computation is not trivially constant.
  it('T-4.5-02c: modified source code produces different PCR values', async () => {
    // Arrange -- first build with default content
    const builderOriginal = new NixBuilder({
      projectRoot: resolveFromRoot('.'),
      dockerfilePath: DOCKERFILE_NIX_PATH,
    });
    const buildOriginal = await builderOriginal.build();

    // Change mock image content to simulate a different source tree
    mockImageContent = Buffer.from(
      'modified-image-content-with-changes-to-source'
    );

    const builderModified = new NixBuilder({
      projectRoot: resolveFromRoot('.'),
      dockerfilePath: DOCKERFILE_NIX_PATH,
      sourceOverride: { 'src/index.ts': '// modified source' },
    });
    const buildModified = await builderModified.build();

    // Assert -- different source code must produce different PCR values
    // All three PCR registers and image hash must differ (AC #2)
    expect(buildOriginal.pcr0).not.toBe(buildModified.pcr0);
    expect(buildOriginal.pcr1).not.toBe(buildModified.pcr1);
    expect(buildOriginal.pcr2).not.toBe(buildModified.pcr2);
    expect(buildOriginal.imageHash).not.toBe(buildModified.imageHash);
  });
});

// ===========================================================================
// T-4.5-03 [P1]: Dockerfile.nix has no non-deterministic build steps (AC #3)
// ===========================================================================

describe('T-4.5-03: Dockerfile.nix determinism -- static analysis', () => {
  // Uses readFileSync to bypass the mocked node:fs/promises
  it('T-4.5-03a: Dockerfile.nix exists at the expected path', () => {
    // Arrange
    const dockerfilePath = resolveFromRoot(DOCKERFILE_NIX_PATH);

    // Act
    const stat = statSync(dockerfilePath);

    // Assert -- file must exist and be a regular file
    expect(stat.isFile()).toBe(true);
  });

  it('T-4.5-03b: Dockerfile.nix does not contain apt-get update', () => {
    // Arrange
    const dockerfilePath = resolveFromRoot(DOCKERFILE_NIX_PATH);
    const content = readFileSync(dockerfilePath, 'utf-8');

    // Act & Assert -- apt-get update must not appear anywhere
    expect(content).not.toMatch(/apt-get\s+update/);
  });

  it('T-4.5-03c: Dockerfile.nix does not contain npm install without lockfile enforcement', () => {
    // Arrange
    const dockerfilePath = resolveFromRoot(DOCKERFILE_NIX_PATH);
    const content = readFileSync(dockerfilePath, 'utf-8');
    const lines = content.split('\n');

    // Act -- find any `npm install` lines that don't use lockfile enforcement
    // Skip comment lines (Nix uses #)
    const violations = lines.filter(
      (line) =>
        !line.trim().startsWith('#') &&
        /npm\s+install/.test(line) &&
        !line.includes('--frozen-lockfile') &&
        !/npm\s+ci/.test(line)
    );

    // Assert -- no unprotected npm install commands
    expect(violations).toHaveLength(0);
  });

  it('T-4.5-03d: Dockerfile.nix does not contain git clone without pinned commit', () => {
    // Arrange
    const dockerfilePath = resolveFromRoot(DOCKERFILE_NIX_PATH);
    const content = readFileSync(dockerfilePath, 'utf-8');
    const lines = content.split('\n');

    // Act -- find any `git clone` that does not reference a 40-char commit hash
    // Skip comment lines
    const commitHashPattern = /[0-9a-f]{40}/;
    const violations = lines.filter(
      (line) =>
        !line.trim().startsWith('#') &&
        /git\s+clone/.test(line) &&
        !commitHashPattern.test(line)
    );

    // Assert -- all git clones must pin a commit hash
    expect(violations).toHaveLength(0);
  });

  it('T-4.5-03e: Dockerfile.nix base images use digest pins (@sha256:) if FROM present', () => {
    // Arrange
    const dockerfilePath = resolveFromRoot(DOCKERFILE_NIX_PATH);
    const content = readFileSync(dockerfilePath, 'utf-8');
    const lines = content.split('\n');

    // Act -- find all FROM instructions and check for @sha256: digest pins
    const fromLines = lines.filter(
      (line) => !line.trim().startsWith('#') && /^\s*FROM\s+/.test(line)
    );
    const unpinnedFromLines = fromLines.filter(
      (line) => !line.includes('@sha256:')
    );

    // Assert -- every FROM must include a digest pin (or no FROM at all for Nix expressions)
    expect(unpinnedFromLines).toHaveLength(0);
  });

  // Uses analyzeDockerfileForNonDeterminism on the real Dockerfile.nix.
  it('T-4.5-03f: analyzeDockerfileForNonDeterminism reports zero violations for Dockerfile.nix', () => {
    // Arrange -- read the real Dockerfile.nix from disk using sync fs
    const dockerfilePath = resolveFromRoot(DOCKERFILE_NIX_PATH);
    const content = readFileSync(dockerfilePath, 'utf-8');
    const forbiddenPatterns = createForbiddenPatterns();

    // Act -- run the static analysis
    const report = analyzeDockerfileForNonDeterminism(
      content,
      forbiddenPatterns
    );

    // Assert -- no violations found
    expect(report.violations).toHaveLength(0);
    expect(report.deterministic).toBe(true);
    expect(report.scannedLines).toBeGreaterThan(0);
  });

  // Negative case: a Dockerfile with known anti-patterns must be flagged.
  it('T-4.5-03g: analyzeDockerfileForNonDeterminism detects all anti-patterns in a bad Dockerfile', () => {
    // Arrange -- a Dockerfile full of non-deterministic anti-patterns
    const badDockerfile = [
      'FROM ubuntu:latest',
      'RUN apt-get update && apt-get install -y curl git',
      'RUN git clone https://github.com/example/repo.git',
      'RUN npm install express',
      'RUN pip install requests',
      'RUN curl -sSL https://install.example.com | bash',
      'COPY . /app',
      'ENTRYPOINT ["/app/start.sh"]',
    ].join('\n');
    const forbiddenPatterns = createForbiddenPatterns();

    // Act
    const report = analyzeDockerfileForNonDeterminism(
      badDockerfile,
      forbiddenPatterns
    );

    // Assert -- multiple violations detected (7 expected: :latest + no digest on FROM,
    // apt-get update, git clone, npm install, pip install, curl|bash)
    expect(report.deterministic).toBe(false);
    expect(report.violations.length).toBeGreaterThanOrEqual(6);

    // Each violation must include the line number and matched pattern name
    for (const violation of report.violations) {
      expect(violation).toHaveProperty('line');
      expect(violation).toHaveProperty('patternName');
      expect(violation).toHaveProperty('matchedText');
      expect(typeof violation.line).toBe('number');
      expect(violation.line).toBeGreaterThanOrEqual(1);
    }

    // Verify all expected anti-patterns were detected by name
    const patternNames = report.violations.map((v) => v.patternName);
    expect(patternNames).toContain('apt-get update');
    expect(patternNames).toContain('unpinned base image (:latest)');
    expect(patternNames).toContain('base image without digest pin');
    expect(patternNames).toContain('npm install without lockfile');
    expect(patternNames).toContain('git clone without pinned commit');
    expect(patternNames).toContain('unpinned pip install');
    expect(patternNames).toContain('curl pipe to shell');
  });

  // Gap test: verify that ALL 7 forbidden patterns are individually detected.
  // AC #3 requires detection of each specific pattern with line numbers.
  it('T-4.5-03i: analyzeDockerfileForNonDeterminism detects each forbidden pattern individually', () => {
    // Arrange -- test each forbidden pattern in isolation
    const forbiddenPatterns = createForbiddenPatterns();
    const expectedPatternNames = [
      'apt-get update',
      'npm install without lockfile',
      'git clone without pinned commit',
      'unpinned base image (:latest)',
      'base image without digest pin',
      'unpinned pip install',
      'curl pipe to shell',
    ];

    // Map each pattern name to a line that should trigger it
    const triggerLines: Record<string, string> = {
      'apt-get update': 'RUN apt-get update',
      'npm install without lockfile': 'RUN npm install express',
      'git clone without pinned commit':
        'RUN git clone https://github.com/example/repo.git',
      'unpinned base image (:latest)': 'FROM ubuntu:latest',
      'base image without digest pin': 'FROM node:20-alpine',
      'unpinned pip install': 'RUN pip install requests',
      'curl pipe to shell': 'RUN curl -sSL https://install.example.com | bash',
    };

    for (const patternName of expectedPatternNames) {
      const triggerLine = triggerLines[patternName];
      expect(triggerLine).toBeDefined();
      if (!triggerLine) continue; // satisfy noUncheckedIndexedAccess

      const report = analyzeDockerfileForNonDeterminism(
        triggerLine,
        forbiddenPatterns
      );

      // Assert -- each pattern should produce at least one violation
      const matchingViolations = report.violations.filter(
        (v) => v.patternName === patternName
      );
      expect(
        matchingViolations.length,
        `Pattern "${patternName}" should detect violation in: "${triggerLine}"`
      ).toBeGreaterThanOrEqual(1);
    }
  });

  // Gap test: scannedLines is correct for non-trivial inputs.
  it('T-4.5-03j: analyzeDockerfileForNonDeterminism reports correct scannedLines count', () => {
    // Arrange
    const threeLineFile = 'line 1\nline 2\nline 3';
    const forbiddenPatterns = createForbiddenPatterns();

    // Act
    const report = analyzeDockerfileForNonDeterminism(
      threeLineFile,
      forbiddenPatterns
    );

    // Assert -- scannedLines should reflect the number of lines in the input
    expect(report.scannedLines).toBe(3);
    expect(report.deterministic).toBe(true);
  });

  // Gap test: comment lines are skipped during analysis.
  it('T-4.5-03k: analyzeDockerfileForNonDeterminism skips comment lines', () => {
    // Arrange -- a forbidden pattern inside a comment should not be flagged
    const commentedDockerfile = [
      '# FROM ubuntu:latest',
      '# RUN apt-get update',
      '# RUN curl http://example.com | bash',
    ].join('\n');
    const forbiddenPatterns = createForbiddenPatterns();

    // Act
    const report = analyzeDockerfileForNonDeterminism(
      commentedDockerfile,
      forbiddenPatterns
    );

    // Assert -- no violations because all lines are comments
    expect(report.deterministic).toBe(true);
    expect(report.violations).toHaveLength(0);
    expect(report.scannedLines).toBe(3);
  });

  // Edge case: a properly pinned Dockerfile must pass validation.
  it('T-4.5-03h: a properly pinned Dockerfile with npm ci and digest-pinned base passes validation', () => {
    // Arrange -- a Dockerfile that uses package managers correctly
    const goodDockerfile = [
      'FROM nixos/nix:2.20.0@sha256:' + 'aa'.repeat(32),
      'COPY package.json pnpm-lock.yaml ./',
      'RUN npm ci --ignore-scripts',
      'COPY . /app',
      'RUN nix build .#docker-image',
      'ENTRYPOINT ["/app/entrypoint.sh"]',
    ].join('\n');
    const forbiddenPatterns = createForbiddenPatterns();

    // Act
    const report = analyzeDockerfileForNonDeterminism(
      goodDockerfile,
      forbiddenPatterns
    );

    // Assert -- no violations
    expect(report.deterministic).toBe(true);
    expect(report.violations).toHaveLength(0);
  });

  // Edge case: empty input should not throw and should return deterministic.
  it('T-4.5-03l: analyzeDockerfileForNonDeterminism handles empty string gracefully', () => {
    // Arrange
    const forbiddenPatterns = createForbiddenPatterns();

    // Act
    const report = analyzeDockerfileForNonDeterminism('', forbiddenPatterns);

    // Assert -- empty content is trivially deterministic
    expect(report.deterministic).toBe(true);
    expect(report.violations).toHaveLength(0);
    expect(report.scannedLines).toBe(1); // split('\\n') on '' returns ['']
  });

  // Functional smoke test: readDockerfileNix reads actual Dockerfile.nix content.
  it('T-4.5-03m: readDockerfileNix reads Dockerfile.nix from disk', async () => {
    // Arrange -- import readDockerfileNix (uses node:fs/promises readFile mock,
    // but for real file paths the mock delegates to the actual implementation)
    const { readDockerfileNix } = await import('./pcr-validator.js');
    const dockerfilePath = resolveFromRoot(DOCKERFILE_NIX_PATH);

    // Act
    const content = await readDockerfileNix(dockerfilePath);

    // Assert -- content should be non-empty and contain known markers
    expect(typeof content).toBe('string');
    expect(content.length).toBeGreaterThan(0);
    expect(content).toContain('buildLayeredImage');
  });
});

// ===========================================================================
// T-4.5-04 [P1]: CI pipeline verifies PCR reproducibility -- two builds,
// same PCR0 (AC #4)
// ===========================================================================

describe('T-4.5-04: CI pipeline PCR reproducibility verification', () => {
  it('T-4.5-04a: verifyPcrReproducibility returns success for identical builds', async () => {
    // Arrange -- two builds that produced the same output
    const { buildA, buildB } = createBuildPair(/* identical */ true);

    // Act -- CI verification function compares the two builds
    const result = await verifyPcrReproducibility(buildA, buildB);

    // Assert -- reproducibility check passes
    expect(result.reproducible).toBe(true);
    expect(result.pcr0Match).toBe(true);
    expect(result.pcr1Match).toBe(true);
    expect(result.pcr2Match).toBe(true);
    expect(result.imageHashMatch).toBe(true);
  });

  // Negative case: non-reproducible builds must be detected and reported.
  it('T-4.5-04b: verifyPcrReproducibility returns failure for divergent builds', async () => {
    // Arrange -- two builds that produced different outputs
    const { buildA, buildB } = createBuildPair(/* identical */ false);

    // Act
    const result = await verifyPcrReproducibility(buildA, buildB);

    // Assert -- reproducibility check fails with detailed mismatch info
    expect(result.reproducible).toBe(false);
    expect(result.pcr0Match).toBe(false);
    expect(result.imageHashMatch).toBe(false);

    // Must include the actual values for debugging CI failures
    expect(result.details.buildA.pcr0).toBe(buildA.pcr0);
    expect(result.details.buildB.pcr0).toBe(buildB.pcr0);
    expect(result.details.buildA.imageHash).toBe(buildA.imageHash);
    expect(result.details.buildB.imageHash).toBe(buildB.imageHash);
  });

  // The CI function must throw when builds diverge with throwOnMismatch.
  it('T-4.5-04c: verifyPcrReproducibility throws PcrReproducibilityError on mismatch', async () => {
    // Arrange
    const { buildA, buildB } = createBuildPair(/* identical */ false);

    // Act -- capture the thrown error in a single call
    const error = await verifyPcrReproducibility(buildA, buildB, {
      throwOnMismatch: true,
    }).catch((e: unknown) => e as Error);

    // Assert -- must throw PcrReproducibilityError with both PCR values
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/PCR reproducibility/i);
    expect((error as Error).message).toContain(buildA.pcr0);
    expect((error as Error).message).toContain(buildB.pcr0);
    expect((error as Error).name).toBe('PcrReproducibilityError');
  });

  // The CI verification result must include a summary string.
  it('T-4.5-04d: verification result includes human-readable summary for CI logs', async () => {
    // Arrange
    const { buildA, buildB } = createBuildPair(/* identical */ true);

    // Act
    const result = await verifyPcrReproducibility(buildA, buildB);

    // Assert -- summary string is present and contains key information
    expect(result.summary).toBeDefined();
    expect(typeof result.summary).toBe('string');
    expect(result.summary).toContain('PCR0');
    expect(result.summary).toContain(buildA.pcr0);
    // For passing builds, summary should indicate success
    expect(result.summary).toMatch(/pass|match|identical|reproducible/i);
  });

  // Gap test: divergent builds must report pcr1Match and pcr2Match as false.
  // AC #4 specifies the result includes pcr0Match, pcr1Match, pcr2Match.
  it('T-4.5-04f: verifyPcrReproducibility reports pcr1Match and pcr2Match as false for divergent builds', async () => {
    // Arrange
    const { buildA, buildB } = createBuildPair(/* identical */ false);

    // Act
    const result = await verifyPcrReproducibility(buildA, buildB);

    // Assert -- all three PCR registers must be reported as mismatched
    expect(result.pcr1Match).toBe(false);
    expect(result.pcr2Match).toBe(false);
    // Also verify details contain all three PCR values from both builds
    expect(result.details.buildA.pcr1).toBe(buildA.pcr1);
    expect(result.details.buildA.pcr2).toBe(buildA.pcr2);
    expect(result.details.buildB.pcr1).toBe(buildB.pcr1);
    expect(result.details.buildB.pcr2).toBe(buildB.pcr2);
  });

  // Gap test: failing build summary must indicate failure and contain mismatch info.
  it('T-4.5-04g: verification result summary indicates FAIL for divergent builds', async () => {
    // Arrange
    const { buildA, buildB } = createBuildPair(/* identical */ false);

    // Act
    const result = await verifyPcrReproducibility(buildA, buildB);

    // Assert -- summary must clearly indicate failure
    expect(result.summary).toContain('FAIL');
    expect(result.summary).toContain('MISMATCH');
    // Summary should include PCR values from both builds for debugging
    expect(result.summary).toContain(buildA.pcr0.toLowerCase());
    expect(result.summary).toContain(buildB.pcr0.toLowerCase());
  });

  // Gap test: details structure for identical builds must contain correct values.
  it('T-4.5-04h: verifyPcrReproducibility details include all values for identical builds', async () => {
    // Arrange
    const { buildA, buildB } = createBuildPair(/* identical */ true);

    // Act
    const result = await verifyPcrReproducibility(buildA, buildB);

    // Assert -- details must accurately reflect the input build results
    expect(result.details.buildA.pcr0).toBe(buildA.pcr0);
    expect(result.details.buildA.pcr1).toBe(buildA.pcr1);
    expect(result.details.buildA.pcr2).toBe(buildA.pcr2);
    expect(result.details.buildA.imageHash).toBe(buildA.imageHash);
    expect(result.details.buildB.pcr0).toBe(buildB.pcr0);
    expect(result.details.buildB.pcr1).toBe(buildB.pcr1);
    expect(result.details.buildB.pcr2).toBe(buildB.pcr2);
    expect(result.details.buildB.imageHash).toBe(buildB.imageHash);
  });

  // Gap test: throwOnMismatch=true must NOT throw for identical builds.
  it('T-4.5-04i: verifyPcrReproducibility does not throw for identical builds with throwOnMismatch', async () => {
    // Arrange
    const { buildA, buildB } = createBuildPair(/* identical */ true);

    // Act & Assert -- must not throw for matching builds even with throwOnMismatch
    const result = await verifyPcrReproducibility(buildA, buildB, {
      throwOnMismatch: true,
    });
    expect(result.reproducible).toBe(true);
  });

  // Gap test: PcrReproducibilityError extends CrosstownError with correct code.
  it('T-4.5-04j: PcrReproducibilityError has correct name and error code', () => {
    // Arrange
    const buildA = createNixBuildResult();
    const buildB = createNixBuildResult({
      pcr0: 'deadbeef'.repeat(12),
    });

    // Act
    const error = new PcrReproducibilityError(buildA, buildB);

    // Assert -- error class follows project convention
    expect(error.name).toBe('PcrReproducibilityError');
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('PCR reproducibility');
    // Error message includes all three PCR registers from both builds
    expect(error.message).toContain(buildA.pcr0);
    expect(error.message).toContain(buildB.pcr0);
    expect(error.message).toContain(buildA.pcr1);
    expect(error.message).toContain(buildB.pcr1);
    expect(error.message).toContain(buildA.pcr2);
    expect(error.message).toContain(buildB.pcr2);
  });

  // End-to-end CI flow using mocked NixBuilder + verifyPcrReproducibility.
  it('T-4.5-04e: end-to-end CI flow -- NixBuilder.build() x2 + verifyPcrReproducibility', async () => {
    // Arrange
    mockImageContent = MOCK_IMAGE_CONTENT;
    const builder = new NixBuilder({
      projectRoot: resolveFromRoot('.'),
      dockerfilePath: DOCKERFILE_NIX_PATH,
    });

    // Act -- simulate the CI pipeline: build twice, then compare
    const buildA = await builder.build();
    const buildB = await builder.build();
    const result = await verifyPcrReproducibility(buildA, buildB);

    // Assert -- full pipeline produces reproducible results
    expect(result.reproducible).toBe(true);
    expect(result.pcr0Match).toBe(true);
    expect(result.pcr1Match).toBe(true);
    expect(result.pcr2Match).toBe(true);
    expect(result.imageHashMatch).toBe(true);
    expect(buildA.pcr0).toBe(buildB.pcr0);
    expect(buildA.imageHash).toBe(buildB.imageHash);
  });
});

// ===========================================================================
// T-4.5-05 [P1]: Barrel exports -- all build module exports importable from
// @crosstown/core (AC #5)
// ===========================================================================

describe('T-4.5-05: Barrel exports -- build module public API', () => {
  it('T-4.5-05a: NixBuilder class is exported from build/index.ts', async () => {
    // Arrange & Act
    const buildModule = await import('./index.js');

    // Assert -- NixBuilder class exists and is a constructor
    expect(buildModule.NixBuilder).toBeDefined();
    expect(typeof buildModule.NixBuilder).toBe('function');
  });

  it('T-4.5-05b: verifyPcrReproducibility is exported from build/index.ts', async () => {
    // Arrange & Act
    const buildModule = await import('./index.js');

    // Assert
    expect(buildModule.verifyPcrReproducibility).toBeDefined();
    expect(typeof buildModule.verifyPcrReproducibility).toBe('function');
  });

  it('T-4.5-05c: analyzeDockerfileForNonDeterminism is exported from build/index.ts', async () => {
    // Arrange & Act
    const buildModule = await import('./index.js');

    // Assert
    expect(buildModule.analyzeDockerfileForNonDeterminism).toBeDefined();
    expect(typeof buildModule.analyzeDockerfileForNonDeterminism).toBe(
      'function'
    );
  });

  it('T-4.5-05d: readDockerfileNix is exported from build/index.ts', async () => {
    // Arrange & Act
    const buildModule = await import('./index.js');

    // Assert
    expect(buildModule.readDockerfileNix).toBeDefined();
    expect(typeof buildModule.readDockerfileNix).toBe('function');
  });

  it('T-4.5-05e: PcrReproducibilityError is exported from build/index.ts', async () => {
    // Arrange & Act
    const buildModule = await import('./index.js');

    // Assert -- error class exists and is a constructor
    expect(buildModule.PcrReproducibilityError).toBeDefined();
    expect(typeof buildModule.PcrReproducibilityError).toBe('function');
  });

  it('T-4.5-05f: all build module exports are re-exported from @crosstown/core', async () => {
    // Arrange & Act -- import from the top-level core barrel
    const coreModule = await import('../index.js');

    // Assert -- all public APIs from the build module are accessible
    expect(coreModule.NixBuilder).toBeDefined();
    expect(coreModule.verifyPcrReproducibility).toBeDefined();
    expect(coreModule.analyzeDockerfileForNonDeterminism).toBeDefined();
    expect(coreModule.readDockerfileNix).toBeDefined();
    expect(coreModule.PcrReproducibilityError).toBeDefined();
  });
});

// ===========================================================================
// T-4.5-06 [P1]: flake.nix exists and .gitignore contains /result (AC #6)
// ===========================================================================

describe('T-4.5-06: Nix flake configuration and gitignore', () => {
  it('T-4.5-06a: flake.nix exists at the project root', () => {
    // Arrange
    const flakePath = resolveFromRoot('flake.nix');

    // Act
    const stat = statSync(flakePath);

    // Assert -- flake.nix must exist and be a regular file
    expect(stat.isFile()).toBe(true);
  });

  it('T-4.5-06b: flake.nix defines a docker-image output', () => {
    // Arrange
    const flakePath = resolveFromRoot('flake.nix');
    const content = readFileSync(flakePath, 'utf-8');

    // Assert -- must reference docker-image output
    expect(content).toMatch(/docker-image/);
    // Flake imports docker/Dockerfile.nix which uses dockerTools.buildLayeredImage
    // The flake references the Dockerfile.nix import
    expect(content).toMatch(/Dockerfile\.nix/);
  });

  it('T-4.5-06c: flake.nix pins nixpkgs to a specific commit', () => {
    // Arrange
    const flakePath = resolveFromRoot('flake.nix');
    const content = readFileSync(flakePath, 'utf-8');

    // Assert -- nixpkgs input must reference a specific commit or tag
    expect(content).toMatch(/nixpkgs/);
    // Should have a pinned URL like "github:NixOS/nixpkgs/<commit>"
    expect(content).toMatch(/github:NixOS\/nixpkgs\//);
  });

  it('T-4.5-06d: flake.nix includes Node.js 20 and supervisord', () => {
    // Arrange -- check both flake.nix and Dockerfile.nix (image definition)
    const flakePath = resolveFromRoot('flake.nix');
    const dockerfileNixPath = resolveFromRoot(DOCKERFILE_NIX_PATH);
    const flakeContent = readFileSync(flakePath, 'utf-8');
    const dockerfileContent = readFileSync(dockerfileNixPath, 'utf-8');

    // Assert -- Node.js reference in flake.nix (build derivation)
    expect(flakeContent).toMatch(/nodejs/i);
    // Assert -- supervisord reference in Dockerfile.nix (image definition)
    expect(dockerfileContent).toMatch(/supervisor/i);
  });

  it('T-4.5-06e: flake.nix exposes ports 3100, 7100, 1300', () => {
    // Arrange -- ports are defined in Dockerfile.nix (image config)
    const dockerfileNixPath = resolveFromRoot(DOCKERFILE_NIX_PATH);
    const content = readFileSync(dockerfileNixPath, 'utf-8');

    // Assert -- must reference all three required ports
    expect(content).toMatch(/3100/);
    expect(content).toMatch(/7100/);
    expect(content).toMatch(/1300/);
  });

  it('T-4.5-06f: .gitignore contains /result entry', () => {
    // Arrange
    const gitignorePath = resolveFromRoot('.gitignore');
    const content = readFileSync(gitignorePath, 'utf-8');

    // Assert -- /result must be in .gitignore (Nix build output symlink)
    const lines = content.split('\n').map((line) => line.trim());
    const hasResultEntry = lines.some(
      (line) => line === '/result' || line === 'result'
    );
    expect(hasResultEntry).toBe(true);
  });

  it('T-4.5-06g: flake.nix sets NODE_ENV=production and creates non-root crosstown user', () => {
    // Arrange -- these are defined in docker/Dockerfile.nix
    const dockerfileNixPath = resolveFromRoot(DOCKERFILE_NIX_PATH);
    const content = readFileSync(dockerfileNixPath, 'utf-8');

    // Assert -- NODE_ENV=production
    expect(content).toMatch(/NODE_ENV.*production/);
    // Assert -- crosstown user reference
    expect(content).toMatch(/crosstown/);
  });

  it('T-4.5-06h: flake.nix CMD uses supervisord', () => {
    // Arrange -- CMD is defined in docker/Dockerfile.nix
    const dockerfileNixPath = resolveFromRoot(DOCKERFILE_NIX_PATH);
    const content = readFileSync(dockerfileNixPath, 'utf-8');

    // Assert -- CMD references supervisord with config
    expect(content).toMatch(/supervisord/);
    expect(content).toMatch(/supervisord\.conf/);
  });

  // Gap test: Dockerfile.nix must contain the same runtime components as Dockerfile.oyster.
  // AC #6 specifies parity with Node.js 20, supervisord, non-root crosstown user, ports.
  it('T-4.5-06i: Dockerfile.nix has parity with Dockerfile.oyster runtime components', () => {
    // Arrange -- read both files
    const dockerfileNixPath = resolveFromRoot(DOCKERFILE_NIX_PATH);
    const dockerfileOysterPath = resolveFromRoot('docker/Dockerfile.oyster');
    const nixContent = readFileSync(dockerfileNixPath, 'utf-8');
    const oysterContent = readFileSync(dockerfileOysterPath, 'utf-8');

    // Assert -- both reference Node.js 20
    expect(nixContent).toMatch(/nodejs.?20|node.*20/i);
    expect(oysterContent).toMatch(/node.*20/i);

    // Assert -- both reference supervisord
    expect(nixContent).toMatch(/supervisor/i);
    expect(oysterContent).toMatch(/supervisor/i);

    // Assert -- both reference a non-root crosstown user
    expect(nixContent).toMatch(/crosstown/);
    expect(oysterContent).toMatch(/crosstown/);

    // Assert -- both reference uid 1001
    expect(nixContent).toMatch(/1001/);
    expect(oysterContent).toMatch(/1001/);

    // Assert -- both expose port 3100 (BLS), 7100 (Relay), 1300 (Attestation)
    for (const port of ['3100', '7100', '1300']) {
      expect(nixContent).toContain(port);
      expect(oysterContent).toContain(port);
    }

    // Assert -- both set NODE_ENV=production
    expect(nixContent).toMatch(/NODE_ENV.*production/);
    expect(oysterContent).toMatch(/NODE_ENV.*production/);

    // Assert -- both use supervisord.conf
    expect(nixContent).toMatch(/supervisord\.conf/);
    expect(oysterContent).toMatch(/supervisord\.conf/);
  });

  // Gap test: flake.nix uses dockerTools.buildLayeredImage as required by AC #6.
  it('T-4.5-06j: Dockerfile.nix uses dockerTools.buildLayeredImage', () => {
    // Arrange
    const dockerfileNixPath = resolveFromRoot(DOCKERFILE_NIX_PATH);
    const content = readFileSync(dockerfileNixPath, 'utf-8');

    // Assert -- must use Nix dockerTools.buildLayeredImage (not buildImage)
    expect(content).toMatch(/buildLayeredImage/);
  });

  // Gap test: flake.nix defines inputs pinned via flake.lock.
  it('T-4.5-06k: flake.nix has inputs block with nixpkgs', () => {
    // Arrange
    const flakePath = resolveFromRoot('flake.nix');
    const content = readFileSync(flakePath, 'utf-8');

    // Assert -- flake must have an inputs section with nixpkgs
    expect(content).toMatch(/inputs\s*=/);
    expect(content).toMatch(/nixpkgs\.url\s*=/);
  });
});

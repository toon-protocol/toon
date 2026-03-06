/**
 * Tests for Nix Reproducible Builds (Story 4.5)
 *
 * TDD RED PHASE — all tests use `it.skip()` because neither the Nix build
 * tooling nor `docker/Dockerfile.nix` exist yet.
 *
 * These tests validate that Nix-based Docker builds produce deterministic
 * outputs: identical image hashes and identical PCR (Platform Configuration
 * Register) values across independent builds. This is the foundation of the
 * TEE attestation trust model — if builds are not reproducible, PCR values
 * cannot be verified against a known-good registry (R-E4-002).
 *
 * Modules under test (DO NOT EXIST YET):
 *   - `./nix-builder.js`      — Nix build orchestration (NixBuilder class)
 *   - `./pcr-validator.js`    — PCR comparison and CI verification utilities
 *   - `docker/Dockerfile.nix` — Deterministic Dockerfile for Nix-based builds
 *
 * Risk: R-E4-002 (Score 6) — Nix build non-reproducibility collapses the
 * attestation verification model.
 */

import { describe, it, expect } from 'vitest';

// These modules DO NOT EXIST yet — imports will cause module-not-found errors
// until the implementation is created in the green phase.
// Uncomment when implementing the green phase:
// import type { NixBuildResult } from './nix-builder.js';
// import { NixBuilder } from './nix-builder.js';
// import {
//   verifyPcrReproducibility,
//   readDockerfileNix,
//   analyzeDockerfileForNonDeterminism,
// } from './pcr-validator.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Path to Dockerfile.nix relative to the project root. */
const DOCKERFILE_NIX_PATH = 'docker/Dockerfile.nix';

/** SHA-384 produces 96-character hex strings. */
const PCR_HEX_LENGTH = 96;

/** Regex pattern for a valid PCR value (96 lowercase hex characters). */
const PCR_HEX_PATTERN = /^[0-9a-f]{96}$/;

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
      pattern: /FROM\s+\S+(?!.*@sha256:)/,
      name: 'base image without digest pin',
      reason:
        'Without @sha256: digest pin, tag can resolve to different images',
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
// consecutive builds
// ===========================================================================

describe('T-4.5-01: Nix build determinism — identical image hashes', () => {
  // Will fail because NixBuilder module does not exist yet.
  // When implemented, NixBuilder.build() must invoke `nix build` and return
  // a NixBuildResult containing the Docker image hash, PCR values, and
  // image store path.
  it.skip('T-4.5-01: two consecutive nix builds produce the same Docker image hash', async () => {
    // Arrange
    const builder = new NixBuilder({
      projectRoot: process.cwd(),
      dockerfilePath: DOCKERFILE_NIX_PATH,
    });

    // Act — run two consecutive builds from the same source tree
    const buildA = await builder.build();
    const buildB = await builder.build();

    // Assert — both builds must produce the exact same image hash
    expect(buildA.imageHash).toBe(buildB.imageHash);

    // Image hashes must be valid sha256 strings
    expect(buildA.imageHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(buildB.imageHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  // Will fail because NixBuilder module does not exist yet.
  // Supplementary: image path in /nix/store should also be identical,
  // since Nix derives the store path from inputs.
  it.skip('T-4.5-01: two consecutive builds produce the same /nix/store path', async () => {
    // Arrange
    const builder = new NixBuilder({
      projectRoot: process.cwd(),
      dockerfilePath: DOCKERFILE_NIX_PATH,
    });

    // Act
    const buildA = await builder.build();
    const buildB = await builder.build();

    // Assert — Nix store paths are content-addressed; same inputs = same path
    expect(buildA.imagePath).toBe(buildB.imagePath);
    expect(buildA.imagePath).toMatch(/^\/nix\/store\//);
  });

  // Will fail because NixBuilder module does not exist yet.
  // Supplementary: NixBuildResult must contain all required fields.
  it.skip('T-4.5-01: NixBuildResult contains imageHash, pcr0-2, and imagePath', async () => {
    // Arrange
    const builder = new NixBuilder({
      projectRoot: process.cwd(),
      dockerfilePath: DOCKERFILE_NIX_PATH,
    });

    // Act
    const result = await builder.build();

    // Assert — all required fields present and properly typed
    expect(result.imageHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.pcr0).toMatch(PCR_HEX_PATTERN);
    expect(result.pcr1).toMatch(PCR_HEX_PATTERN);
    expect(result.pcr2).toMatch(PCR_HEX_PATTERN);
    expect(result.pcr0).toHaveLength(PCR_HEX_LENGTH);
    expect(result.imagePath).toBeDefined();
    expect(typeof result.buildTimestamp).toBe('number');
  });
});

// ===========================================================================
// T-4.5-02 [P0]: Nix build produces identical PCR values across two
// independent builds
// ===========================================================================

describe('T-4.5-02: Nix build determinism — identical PCR values', () => {
  // Will fail because NixBuilder module does not exist yet.
  // PCR (Platform Configuration Register) values are SHA-384 hashes that
  // the TEE hardware measures from the loaded image. If the same image
  // produces different PCR values, attestation verification breaks completely.
  it.skip('T-4.5-02: two independent nix builds produce identical PCR0 values', async () => {
    // Arrange
    const builder = new NixBuilder({
      projectRoot: process.cwd(),
      dockerfilePath: DOCKERFILE_NIX_PATH,
    });

    // Act — two independent builds (simulating separate CI jobs)
    const buildA = await builder.build();
    const buildB = await builder.build();

    // Assert — PCR0 must be identical across builds
    expect(buildA.pcr0).toBe(buildB.pcr0);
    expect(buildA.pcr0).toMatch(PCR_HEX_PATTERN);
  });

  // Will fail because NixBuilder module does not exist yet.
  // All three PCR registers must be identical, not just PCR0.
  it.skip('T-4.5-02: all three PCR values (pcr0, pcr1, pcr2) are identical across builds', async () => {
    // Arrange
    const builder = new NixBuilder({
      projectRoot: process.cwd(),
      dockerfilePath: DOCKERFILE_NIX_PATH,
    });

    // Act
    const buildA = await builder.build();
    const buildB = await builder.build();

    // Assert — all three PCR registers must match
    expect(buildA.pcr0).toBe(buildB.pcr0);
    expect(buildA.pcr1).toBe(buildB.pcr1);
    expect(buildA.pcr2).toBe(buildB.pcr2);

    // Each PCR must be a valid SHA-384 hex string (96 chars)
    for (const pcr of [buildA.pcr0, buildA.pcr1, buildA.pcr2]) {
      expect(pcr).toHaveLength(PCR_HEX_LENGTH);
      expect(pcr).toMatch(PCR_HEX_PATTERN);
    }
  });

  // Will fail because NixBuilder module does not exist yet.
  // Negative case: modifying source code must produce DIFFERENT PCR values.
  // This proves the PCR computation is not trivially constant.
  it.skip('T-4.5-02: modified source code produces different PCR values', async () => {
    // Arrange — create two builders pointing at different source trees
    // (in practice, the second build would have a modified file)
    const builderOriginal = new NixBuilder({
      projectRoot: process.cwd(),
      dockerfilePath: DOCKERFILE_NIX_PATH,
    });
    const builderModified = new NixBuilder({
      projectRoot: process.cwd(),
      dockerfilePath: DOCKERFILE_NIX_PATH,
      // The implementation should detect source changes and produce
      // different PCR values. This override simulates a code change.
      sourceOverride: { 'src/index.ts': '// modified source' },
    });

    // Act
    const buildOriginal = await builderOriginal.build();
    const buildModified = await builderModified.build();

    // Assert — different source code must produce different PCR0
    expect(buildOriginal.pcr0).not.toBe(buildModified.pcr0);
    expect(buildOriginal.imageHash).not.toBe(buildModified.imageHash);
  });
});

// ===========================================================================
// T-4.5-03 [P1]: Dockerfile.nix has no non-deterministic build steps
// ===========================================================================

describe('T-4.5-03: Dockerfile.nix determinism — static analysis', () => {
  // Will fail because docker/Dockerfile.nix does not exist yet.
  // When created, Dockerfile.nix must use only deterministic build steps
  // (Nix flake references, pinned dependencies, content-addressed stores).
  it.skip('T-4.5-03: Dockerfile.nix exists at the expected path', async () => {
    // Arrange
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const dockerfilePath = path.resolve(process.cwd(), DOCKERFILE_NIX_PATH);

    // Act
    const stat = await fs.stat(dockerfilePath);

    // Assert — file must exist and be a regular file
    expect(stat.isFile()).toBe(true);
  });

  // Will fail because docker/Dockerfile.nix does not exist yet.
  // No `apt-get update` — package indices change daily, producing different
  // image layers on every build.
  it.skip('T-4.5-03: Dockerfile.nix does not contain apt-get update', async () => {
    // Arrange
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const dockerfilePath = path.resolve(process.cwd(), DOCKERFILE_NIX_PATH);
    const content = await fs.readFile(dockerfilePath, 'utf-8');

    // Act & Assert — apt-get update must not appear anywhere
    expect(content).not.toMatch(/apt-get\s+update/);
  });

  // Will fail because docker/Dockerfile.nix does not exist yet.
  // No `npm install` without lockfile — must use `npm ci` or `--frozen-lockfile`
  // to ensure deterministic dependency resolution.
  it.skip('T-4.5-03: Dockerfile.nix does not contain npm install without lockfile enforcement', async () => {
    // Arrange
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const dockerfilePath = path.resolve(process.cwd(), DOCKERFILE_NIX_PATH);
    const content = await fs.readFile(dockerfilePath, 'utf-8');
    const lines = content.split('\n');

    // Act — find any `npm install` lines that don't use lockfile enforcement
    const violations = lines.filter(
      (line) =>
        /npm\s+install/.test(line) &&
        !line.includes('--frozen-lockfile') &&
        !/npm\s+ci/.test(line)
    );

    // Assert — no unprotected npm install commands
    expect(violations).toHaveLength(0);
  });

  // Will fail because docker/Dockerfile.nix does not exist yet.
  // No `git clone` without pinned commit hash — HEAD changes over time,
  // producing non-deterministic builds.
  it.skip('T-4.5-03: Dockerfile.nix does not contain git clone without pinned commit', async () => {
    // Arrange
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const dockerfilePath = path.resolve(process.cwd(), DOCKERFILE_NIX_PATH);
    const content = await fs.readFile(dockerfilePath, 'utf-8');
    const lines = content.split('\n');

    // Act — find any `git clone` that does not reference a 40-char commit hash
    const commitHashPattern = /[0-9a-f]{40}/;
    const violations = lines.filter(
      (line) => /git\s+clone/.test(line) && !commitHashPattern.test(line)
    );

    // Assert — all git clones must pin a commit hash
    expect(violations).toHaveLength(0);
  });

  // Will fail because docker/Dockerfile.nix does not exist yet.
  // No unpinned package versions — base images must use @sha256: digest pins,
  // not floating tags like `:latest`.
  it.skip('T-4.5-03: Dockerfile.nix base images use digest pins (@sha256:)', async () => {
    // Arrange
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const dockerfilePath = path.resolve(process.cwd(), DOCKERFILE_NIX_PATH);
    const content = await fs.readFile(dockerfilePath, 'utf-8');
    const lines = content.split('\n');

    // Act — find all FROM instructions and check for @sha256: digest pins
    const fromLines = lines.filter((line) => /^\s*FROM\s+/.test(line));
    const unpinnedFromLines = fromLines.filter(
      (line) => !line.includes('@sha256:')
    );

    // Assert — every FROM must include a digest pin
    expect(unpinnedFromLines).toHaveLength(0);
  });

  // Will fail because pcr-validator module (analyzeDockerfileForNonDeterminism)
  // does not exist yet. This test uses the static analysis utility to check
  // all forbidden patterns in a single pass, producing a structured report.
  it.skip('T-4.5-03: analyzeDockerfileForNonDeterminism reports zero violations for Dockerfile.nix', async () => {
    // Arrange — read the real Dockerfile.nix from disk
    const content = await readDockerfileNix(DOCKERFILE_NIX_PATH);
    const forbiddenPatterns = createForbiddenPatterns();

    // Act — run the static analysis
    const report = analyzeDockerfileForNonDeterminism(
      content,
      forbiddenPatterns
    );

    // Assert — no violations found
    expect(report.violations).toHaveLength(0);
    expect(report.deterministic).toBe(true);
    expect(report.scannedLines).toBeGreaterThan(0);
  });

  // Will fail because pcr-validator module does not exist yet.
  // Negative case: a Dockerfile with known anti-patterns must be flagged.
  // This validates the static analysis utility itself is correct.
  it.skip('T-4.5-03: analyzeDockerfileForNonDeterminism detects all anti-patterns in a bad Dockerfile', () => {
    // Arrange — a Dockerfile full of non-deterministic anti-patterns
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

    // Assert — multiple violations detected
    expect(report.deterministic).toBe(false);
    expect(report.violations.length).toBeGreaterThanOrEqual(4);

    // Each violation must include the line number and matched pattern name
    for (const violation of report.violations) {
      expect(violation).toHaveProperty('line');
      expect(violation).toHaveProperty('patternName');
      expect(violation).toHaveProperty('matchedText');
      expect(typeof violation.line).toBe('number');
      expect(violation.line).toBeGreaterThanOrEqual(1);
    }

    // Verify specific anti-patterns were detected
    const patternNames = report.violations.map(
      (v: { patternName: string }) => v.patternName
    );
    expect(patternNames).toContain('apt-get update');
    expect(patternNames).toContain('unpinned base image (:latest)');
    expect(patternNames).toContain('curl pipe to shell');
  });

  // Will fail because pcr-validator module does not exist yet.
  // Edge case: a properly pinned Dockerfile (with digest pins, npm ci, etc.)
  // must pass validation even though it uses package managers.
  it.skip('T-4.5-03: a properly pinned Dockerfile with npm ci and digest-pinned base passes validation', () => {
    // Arrange — a Dockerfile that uses package managers correctly
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

    // Assert — no violations
    expect(report.deterministic).toBe(true);
    expect(report.violations).toHaveLength(0);
  });
});

// ===========================================================================
// T-4.5-04 [P1]: CI pipeline verifies PCR reproducibility — two builds,
// same PCR0
// ===========================================================================

describe('T-4.5-04: CI pipeline PCR reproducibility verification', () => {
  // Will fail because pcr-validator module (verifyPcrReproducibility) does
  // not exist yet. When implemented, this function must:
  // 1. Run two independent Nix builds
  // 2. Extract PCR values from each
  // 3. Compare all three PCR registers
  // 4. Return a pass/fail result with detailed comparison data
  it.skip('T-4.5-04: verifyPcrReproducibility returns success for identical builds', async () => {
    // Arrange — two builds that produced the same output
    const { buildA, buildB } = createBuildPair(/* identical */ true);

    // Act — CI verification function compares the two builds
    const result = await verifyPcrReproducibility(buildA, buildB);

    // Assert — reproducibility check passes
    expect(result.reproducible).toBe(true);
    expect(result.pcr0Match).toBe(true);
    expect(result.pcr1Match).toBe(true);
    expect(result.pcr2Match).toBe(true);
    expect(result.imageHashMatch).toBe(true);
  });

  // Will fail because pcr-validator module does not exist yet.
  // Negative case: non-reproducible builds must be detected and reported.
  it.skip('T-4.5-04: verifyPcrReproducibility returns failure for divergent builds', async () => {
    // Arrange — two builds that produced different outputs
    const { buildA, buildB } = createBuildPair(/* identical */ false);

    // Act
    const result = await verifyPcrReproducibility(buildA, buildB);

    // Assert — reproducibility check fails with detailed mismatch info
    expect(result.reproducible).toBe(false);
    expect(result.pcr0Match).toBe(false);
    expect(result.imageHashMatch).toBe(false);

    // Must include the actual values for debugging CI failures
    expect(result.details.buildA.pcr0).toBe(buildA.pcr0);
    expect(result.details.buildB.pcr0).toBe(buildB.pcr0);
    expect(result.details.buildA.imageHash).toBe(buildA.imageHash);
    expect(result.details.buildB.imageHash).toBe(buildB.imageHash);
  });

  // Will fail because pcr-validator module does not exist yet.
  // The CI function must throw with a descriptive error when builds diverge,
  // so CI pipelines can fail the job with a clear message.
  it.skip('T-4.5-04: verifyPcrReproducibility throws PcrReproducibilityError on mismatch', async () => {
    // Arrange
    const { buildA, buildB } = createBuildPair(/* identical */ false);

    // Act & Assert — must throw with both PCR values in the message
    await expect(
      verifyPcrReproducibility(buildA, buildB, { throwOnMismatch: true })
    ).rejects.toThrow(/PCR reproducibility/i);

    // Verify the error contains enough context for CI debugging
    try {
      await verifyPcrReproducibility(buildA, buildB, { throwOnMismatch: true });
    } catch (error: unknown) {
      const err = error as Error;
      expect(err.message).toContain(buildA.pcr0);
      expect(err.message).toContain(buildB.pcr0);
      expect(err.name).toBe('PcrReproducibilityError');
    }
  });

  // Will fail because pcr-validator module does not exist yet.
  // The CI verification result must include a summary string suitable for
  // CI output logs, containing pass/fail status and PCR values.
  it.skip('T-4.5-04: verification result includes human-readable summary for CI logs', async () => {
    // Arrange
    const { buildA, buildB } = createBuildPair(/* identical */ true);

    // Act
    const result = await verifyPcrReproducibility(buildA, buildB);

    // Assert — summary string is present and contains key information
    expect(result.summary).toBeDefined();
    expect(typeof result.summary).toBe('string');
    expect(result.summary).toContain('PCR0');
    expect(result.summary).toContain(buildA.pcr0);
    // For passing builds, summary should indicate success
    expect(result.summary).toMatch(/pass|match|identical|reproducible/i);
  });

  // Will fail because pcr-validator module does not exist yet.
  // End-to-end CI flow: build twice using NixBuilder, then verify with
  // verifyPcrReproducibility. This tests the full pipeline integration.
  it.skip('T-4.5-04: end-to-end CI flow — NixBuilder.build() x2 + verifyPcrReproducibility', async () => {
    // Arrange
    const builder = new NixBuilder({
      projectRoot: process.cwd(),
      dockerfilePath: DOCKERFILE_NIX_PATH,
    });

    // Act — simulate the CI pipeline: build twice, then compare
    const buildA = await builder.build();
    const buildB = await builder.build();
    const result = await verifyPcrReproducibility(buildA, buildB);

    // Assert — full pipeline produces reproducible results
    expect(result.reproducible).toBe(true);
    expect(result.pcr0Match).toBe(true);
    expect(result.pcr1Match).toBe(true);
    expect(result.pcr2Match).toBe(true);
    expect(result.imageHashMatch).toBe(true);
    expect(buildA.pcr0).toBe(buildB.pcr0);
    expect(buildA.imageHash).toBe(buildB.imageHash);
  });
});

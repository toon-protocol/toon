import { describe, it, expect } from 'vitest';

// These modules don't exist yet — TDD red phase.
// Imports will fail until the implementation is created.
// Uncomment when implementing the green phase:
// import { computePcr, comparePcrs, PcrMismatchError } from './reproducibility.js';
// import { validateDockerfileDeterminism } from './dockerfile-validator.js';

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const KNOWN_IMAGE_HASH = 'sha256:' + 'ab12cd34'.repeat(8);
const KNOWN_PCR0 = 'a1b2c3d4'.repeat(12); // 96 hex chars (SHA-384)

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

/** Create a minimal deterministic Dockerfile with no non-deterministic steps. */
function createDeterministicDockerfile(): string {
  return [
    'FROM nixos/nix:2.20.0@sha256:' + 'aa'.repeat(32),
    'COPY . /app',
    'RUN nix build .#docker-image',
    'ENTRYPOINT ["/app/entrypoint.sh"]',
  ].join('\n');
}

/** Create a Dockerfile containing typical non-deterministic anti-patterns. */
function createNonDeterministicDockerfile(): string {
  return [
    'FROM ubuntu:latest',
    'RUN apt-get update && apt-get install -y curl',
    'RUN curl -sSL https://install.example.com | bash',
    'RUN pip install requests',
    'COPY . /app',
    'ENTRYPOINT ["/app/entrypoint.sh"]',
  ].join('\n');
}

/** Create a PCR result object for comparison tests. */
function createPcrResult(pcr0: string): {
  pcr0: string;
  pcr1: string;
  pcr2: string;
} {
  return {
    pcr0,
    pcr1: 'b'.repeat(96),
    pcr2: 'c'.repeat(96),
  };
}

// ---------------------------------------------------------------------------
// T-4.5-01 [P0]: Nix build produces identical Docker image hash across two
// consecutive builds
// ---------------------------------------------------------------------------

describe('computePcr', () => {
  // T-4.5-01: In unit form we verify the PCR computation function is
  // deterministic — the same image hash always yields the same PCR0.
  // Will fail because computePcr does not exist yet.
  it.skip('produces identical PCR0 for the same image hash (T-4.5-01)', () => {
    // Arrange
    const imageHash = KNOWN_IMAGE_HASH;

    // Act
    const pcr1 = computePcr(imageHash);
    const pcr2 = computePcr(imageHash);

    // Assert — two calls with the same input must return the same PCR0
    expect(pcr1.pcr0).toBe(pcr2.pcr0);
    expect(pcr1.pcr0).toMatch(/^[0-9a-f]{96}$/);
  });

  // T-4.5-01 (supplementary): PCR0 output is a valid 96-char hex string
  // (SHA-384 digest).
  // Will fail because computePcr does not exist yet.
  it.skip('returns PCR0 as a 96-character lowercase hex string (T-4.5-01)', () => {
    // Arrange
    const imageHash = KNOWN_IMAGE_HASH;

    // Act
    const result = computePcr(imageHash);

    // Assert
    expect(result.pcr0).toHaveLength(96);
    expect(result.pcr0).toMatch(/^[0-9a-f]+$/);
  });

  // T-4.5-01 (supplementary): Different image hashes produce different PCR0
  // values — proves the computation is not constant.
  // Will fail because computePcr does not exist yet.
  it.skip('produces different PCR0 for different image hashes (T-4.5-01)', () => {
    // Arrange
    const imageHashA = 'sha256:' + 'aa'.repeat(32);
    const imageHashB = 'sha256:' + 'bb'.repeat(32);

    // Act
    const pcrA = computePcr(imageHashA);
    const pcrB = computePcr(imageHashB);

    // Assert — different inputs must produce different outputs
    expect(pcrA.pcr0).not.toBe(pcrB.pcr0);
  });

  // T-4.5-01 (supplementary): computePcr also returns pcr1 and pcr2 fields.
  // Will fail because computePcr does not exist yet.
  it.skip('returns pcr0, pcr1, and pcr2 fields (T-4.5-01)', () => {
    // Arrange
    const imageHash = KNOWN_IMAGE_HASH;

    // Act
    const result = computePcr(imageHash);

    // Assert
    expect(result).toHaveProperty('pcr0');
    expect(result).toHaveProperty('pcr1');
    expect(result).toHaveProperty('pcr2');
    expect(result.pcr0).toMatch(/^[0-9a-f]{96}$/);
    expect(result.pcr1).toMatch(/^[0-9a-f]{96}$/);
    expect(result.pcr2).toMatch(/^[0-9a-f]{96}$/);
  });
});

// ---------------------------------------------------------------------------
// T-4.5-02 [P0]: Nix build produces identical PCR values across two
// independent builds
// ---------------------------------------------------------------------------

describe('comparePcrs', () => {
  // T-4.5-02: Given deterministic Nix config, PCR values computed from two
  // builds match. In unit form: verify the comparison utility correctly
  // detects matching PCR sets.
  // Will fail because comparePcrs does not exist yet.
  it.skip('returns true when PCR0 values from two builds match (T-4.5-02)', () => {
    // Arrange
    const buildA = createPcrResult(KNOWN_PCR0);
    const buildB = createPcrResult(KNOWN_PCR0);

    // Act
    const result = comparePcrs(buildA, buildB);

    // Assert
    expect(result).toBe(true);
  });

  // T-4.5-02 (negative): Mismatched PCR0 values are detected as a mismatch.
  // Will fail because comparePcrs does not exist yet.
  it.skip('returns false when PCR0 values differ (T-4.5-02)', () => {
    // Arrange
    const buildA = createPcrResult(KNOWN_PCR0);
    const buildB = createPcrResult('ff'.repeat(48)); // Different PCR0

    // Act
    const result = comparePcrs(buildA, buildB);

    // Assert
    expect(result).toBe(false);
  });

  // T-4.5-02 (supplementary): comparePcrs also checks pcr1 and pcr2, not
  // just pcr0.
  // Will fail because comparePcrs does not exist yet.
  it.skip('returns false when pcr1 differs even if pcr0 matches (T-4.5-02)', () => {
    // Arrange
    const buildA = {
      pcr0: KNOWN_PCR0,
      pcr1: 'b'.repeat(96),
      pcr2: 'c'.repeat(96),
    };
    const buildB = {
      pcr0: KNOWN_PCR0,
      pcr1: 'e'.repeat(96),
      pcr2: 'c'.repeat(96),
    };

    // Act
    const result = comparePcrs(buildA, buildB);

    // Assert
    expect(result).toBe(false);
  });

  // T-4.5-02 (supplementary): Comparison is case-insensitive — uppercase hex
  // must match lowercase hex.
  // Will fail because comparePcrs does not exist yet.
  it.skip('treats hex comparison as case-insensitive (T-4.5-02)', () => {
    // Arrange
    const buildA = createPcrResult(KNOWN_PCR0.toLowerCase());
    const buildB = createPcrResult(KNOWN_PCR0.toUpperCase());

    // Act
    const result = comparePcrs(buildA, buildB);

    // Assert
    expect(result).toBe(true);
  });
});

describe('PcrMismatchError', () => {
  // T-4.5-04 (unit primitive): The error type used when PCR comparison fails
  // in CI must include both expected and actual PCR values for debugging.
  // Will fail because PcrMismatchError does not exist yet.
  it.skip('includes expected and actual PCR0 values in message (T-4.5-04)', () => {
    // Arrange
    const expected = KNOWN_PCR0;
    const actual = 'ff'.repeat(48);

    // Act
    const error = new PcrMismatchError(expected, actual);

    // Assert
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(expected);
    expect(error.message).toContain(actual);
    expect(error.name).toBe('PcrMismatchError');
  });

  // T-4.5-04 (supplementary): PcrMismatchError exposes structured fields for
  // programmatic access.
  // Will fail because PcrMismatchError does not exist yet.
  it.skip('exposes expectedPcr0 and actualPcr0 properties (T-4.5-04)', () => {
    // Arrange
    const expected = KNOWN_PCR0;
    const actual = 'ff'.repeat(48);

    // Act
    const error = new PcrMismatchError(expected, actual);

    // Assert
    expect(error.expectedPcr0).toBe(expected);
    expect(error.actualPcr0).toBe(actual);
  });
});

// ---------------------------------------------------------------------------
// T-4.5-03 [P1]: Dockerfile.nix has no non-deterministic build steps
// ---------------------------------------------------------------------------

describe('validateDockerfileDeterminism', () => {
  // T-4.5-03: A clean Dockerfile with only deterministic steps passes
  // validation.
  // Will fail because validateDockerfileDeterminism does not exist yet.
  it.skip('accepts a Dockerfile with only deterministic steps (T-4.5-03)', () => {
    // Arrange
    const dockerfile = createDeterministicDockerfile();

    // Act
    const result = validateDockerfileDeterminism(dockerfile);

    // Assert
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  // T-4.5-03 (anti-pattern): `apt-get update` introduces non-determinism
  // because package indices change over time.
  // Will fail because validateDockerfileDeterminism does not exist yet.
  it.skip('rejects Dockerfile containing apt-get update (T-4.5-03)', () => {
    // Arrange
    const dockerfile = [
      'FROM nixos/nix:2.20.0@sha256:' + 'aa'.repeat(32),
      'RUN apt-get update && apt-get install -y curl',
      'COPY . /app',
    ].join('\n');

    // Act
    const result = validateDockerfileDeterminism(dockerfile);

    // Assert
    expect(result.valid).toBe(false);
    expect(result.violations.length).toBeGreaterThanOrEqual(1);
    expect(result.violations.some((v) => v.pattern === 'apt-get update')).toBe(
      true
    );
  });

  // T-4.5-03 (anti-pattern): Unpinned base image (`FROM ubuntu:latest`)
  // produces different layers on every build.
  // Will fail because validateDockerfileDeterminism does not exist yet.
  it.skip('rejects Dockerfile with unpinned base image tag (T-4.5-03)', () => {
    // Arrange
    const dockerfile = [
      'FROM ubuntu:latest',
      'COPY . /app',
      'ENTRYPOINT ["/app/entrypoint.sh"]',
    ].join('\n');

    // Act
    const result = validateDockerfileDeterminism(dockerfile);

    // Assert
    expect(result.valid).toBe(false);
    expect(
      result.violations.some((v) => v.pattern === 'unpinned base image')
    ).toBe(true);
  });

  // T-4.5-03 (anti-pattern): `curl | bash` pattern fetches arbitrary remote
  // content — inherently non-deterministic.
  // Will fail because validateDockerfileDeterminism does not exist yet.
  it.skip('rejects Dockerfile with curl-pipe-bash pattern (T-4.5-03)', () => {
    // Arrange
    const dockerfile = [
      'FROM nixos/nix:2.20.0@sha256:' + 'aa'.repeat(32),
      'RUN curl -sSL https://install.example.com | bash',
      'COPY . /app',
    ].join('\n');

    // Act
    const result = validateDockerfileDeterminism(dockerfile);

    // Assert
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.pattern === 'curl pipe bash')).toBe(
      true
    );
  });

  // T-4.5-03 (anti-pattern): `pip install` without pinned versions downloads
  // latest packages, which change over time.
  // Will fail because validateDockerfileDeterminism does not exist yet.
  it.skip('rejects Dockerfile with unpinned pip install (T-4.5-03)', () => {
    // Arrange
    const dockerfile = [
      'FROM nixos/nix:2.20.0@sha256:' + 'aa'.repeat(32),
      'RUN pip install requests flask',
      'COPY . /app',
    ].join('\n');

    // Act
    const result = validateDockerfileDeterminism(dockerfile);

    // Assert
    expect(result.valid).toBe(false);
    expect(
      result.violations.some((v) => v.pattern === 'unpinned pip install')
    ).toBe(true);
  });

  // T-4.5-03 (anti-pattern): `npm install` without lockfile or pinned versions
  // is non-deterministic.
  // Will fail because validateDockerfileDeterminism does not exist yet.
  it.skip('rejects Dockerfile with unpinned npm install (T-4.5-03)', () => {
    // Arrange
    const dockerfile = [
      'FROM nixos/nix:2.20.0@sha256:' + 'aa'.repeat(32),
      'RUN npm install express',
      'COPY . /app',
    ].join('\n');

    // Act
    const result = validateDockerfileDeterminism(dockerfile);

    // Assert
    expect(result.valid).toBe(false);
    expect(
      result.violations.some((v) => v.pattern === 'unpinned npm install')
    ).toBe(true);
  });

  // T-4.5-03 (compound): A Dockerfile with multiple anti-patterns reports all
  // violations, not just the first one.
  // Will fail because validateDockerfileDeterminism does not exist yet.
  it.skip('reports all violations in a Dockerfile with multiple anti-patterns (T-4.5-03)', () => {
    // Arrange
    const dockerfile = createNonDeterministicDockerfile();

    // Act
    const result = validateDockerfileDeterminism(dockerfile);

    // Assert — should find at least: unpinned base image, apt-get update,
    // curl pipe bash, unpinned pip install
    expect(result.valid).toBe(false);
    expect(result.violations.length).toBeGreaterThanOrEqual(4);
  });

  // T-4.5-03 (supplementary): Each violation includes the line number where
  // the anti-pattern was detected, for actionable feedback.
  // Will fail because validateDockerfileDeterminism does not exist yet.
  it.skip('includes line numbers in violation reports (T-4.5-03)', () => {
    // Arrange
    const dockerfile = [
      'FROM ubuntu:latest',
      'RUN apt-get update',
      'COPY . /app',
    ].join('\n');

    // Act
    const result = validateDockerfileDeterminism(dockerfile);

    // Assert
    expect(result.violations.length).toBeGreaterThanOrEqual(1);
    for (const violation of result.violations) {
      expect(violation).toHaveProperty('line');
      expect(typeof violation.line).toBe('number');
      expect(violation.line).toBeGreaterThanOrEqual(1);
    }
  });

  // T-4.5-03 (supplementary): A pinned base image with digest passes
  // validation — only unpinned tags are rejected.
  // Will fail because validateDockerfileDeterminism does not exist yet.
  it.skip('accepts FROM with digest-pinned base image (T-4.5-03)', () => {
    // Arrange
    const dockerfile = [
      'FROM ubuntu:22.04@sha256:' + 'dd'.repeat(32),
      'COPY . /app',
      'ENTRYPOINT ["/app/entrypoint.sh"]',
    ].join('\n');

    // Act
    const result = validateDockerfileDeterminism(dockerfile);

    // Assert — no "unpinned base image" violation
    expect(
      result.violations.some((v) => v.pattern === 'unpinned base image')
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T-4.5-04 [P1]: CI pipeline verifies PCR reproducibility — two builds,
// same PCR0
// ---------------------------------------------------------------------------

describe('PCR comparison utility (CI integration primitives)', () => {
  // T-4.5-04: The comparison utility correctly identifies matching PCR sets
  // as identical — this is the primitive the CI pipeline uses to verify
  // reproducibility.
  // Will fail because comparePcrs does not exist yet.
  it.skip('comparePcrs returns true for identical PCR sets from two builds (T-4.5-04)', () => {
    // Arrange — simulate two CI builds producing the same image
    const buildOneHash = KNOWN_IMAGE_HASH;
    const buildTwoHash = KNOWN_IMAGE_HASH;
    const pcrBuildOne = computePcr(buildOneHash);
    const pcrBuildTwo = computePcr(buildTwoHash);

    // Act
    const match = comparePcrs(pcrBuildOne, pcrBuildTwo);

    // Assert
    expect(match).toBe(true);
  });

  // T-4.5-04 (negative): The comparison utility correctly detects
  // non-reproducible builds where PCR values differ.
  // Will fail because comparePcrs does not exist yet.
  it.skip('comparePcrs returns false for divergent builds (T-4.5-04)', () => {
    // Arrange — simulate two CI builds producing different images
    const pcrBuildOne = createPcrResult(KNOWN_PCR0);
    const pcrBuildTwo = createPcrResult('de'.repeat(48));

    // Act
    const match = comparePcrs(pcrBuildOne, pcrBuildTwo);

    // Assert
    expect(match).toBe(false);
  });

  // T-4.5-04 (supplementary): The end-to-end CI flow — compute PCR from
  // image hash, then compare — produces consistent results.
  // Will fail because computePcr and comparePcrs do not exist yet.
  it.skip('end-to-end: computePcr + comparePcrs round-trip is consistent (T-4.5-04)', () => {
    // Arrange
    const imageHash = KNOWN_IMAGE_HASH;

    // Act — compute PCRs independently (simulating two CI jobs)
    const pcrFirst = computePcr(imageHash);
    const pcrSecond = computePcr(imageHash);
    const match = comparePcrs(pcrFirst, pcrSecond);

    // Assert
    expect(match).toBe(true);
    expect(pcrFirst.pcr0).toBe(pcrSecond.pcr0);
  });
});

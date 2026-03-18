/**
 * PCR Validation and Dockerfile Determinism Analysis
 *
 * Provides utilities for verifying PCR (Platform Configuration Register)
 * reproducibility across independent Nix builds, and for statically
 * analyzing Dockerfile.nix expressions for non-deterministic patterns.
 *
 * PCR values are SHA-384 hashes (96 lowercase hex characters) measured
 * by the TEE hardware. If two builds of the same source tree produce
 * different PCR values, the attestation verification model collapses
 * (R-E4-002, Score 6) because the AttestationVerifier cannot compare
 * observed PCR values against a known-good registry.
 *
 * @module
 */

import { readFile } from 'node:fs/promises';
import { ToonError } from '../errors.js';
import type { NixBuildResult } from './nix-builder.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A forbidden pattern that must not appear in a deterministic Dockerfile/Nix
 * expression. Each entry includes a regex, a human-readable name, and an
 * explanation of why the pattern breaks reproducibility.
 */
export interface ForbiddenPattern {
  /** Regex to match against each line of the Dockerfile */
  pattern: RegExp;
  /** Human-readable name of the pattern (e.g., 'apt-get update') */
  name: string;
  /** Explanation of why this pattern breaks reproducibility */
  reason: string;
}

/**
 * A single violation found during determinism analysis. Includes the line
 * number (1-indexed), the name of the matched pattern, and the text that
 * triggered the match.
 */
export interface Violation {
  /** Line number (1-indexed) where the violation was found */
  line: number;
  /** Name of the forbidden pattern that matched */
  patternName: string;
  /** The text from the line that triggered the match */
  matchedText: string;
}

/**
 * Result of analyzing a Dockerfile for non-deterministic patterns.
 */
export interface DeterminismReport {
  /** True if no forbidden patterns were found */
  deterministic: boolean;
  /** List of violations found (empty if deterministic) */
  violations: Violation[];
  /** Number of lines scanned */
  scannedLines: number;
}

/**
 * Result of comparing two NixBuildResults for PCR reproducibility.
 */
export interface PcrReproducibilityResult {
  /** True if all PCR values and image hash match */
  reproducible: boolean;
  /** Whether PCR0 values match */
  pcr0Match: boolean;
  /** Whether PCR1 values match */
  pcr1Match: boolean;
  /** Whether PCR2 values match */
  pcr2Match: boolean;
  /** Whether Docker image content hashes match */
  imageHashMatch: boolean;
  /** The actual PCR and hash values from both builds for debugging */
  details: {
    buildA: { pcr0: string; pcr1: string; pcr2: string; imageHash: string };
    buildB: { pcr0: string; pcr1: string; pcr2: string; imageHash: string };
  };
  /** Human-readable summary suitable for CI log output */
  summary: string;
}

/**
 * Options for verifyPcrReproducibility().
 */
export interface VerifyOptions {
  /** If true, throws PcrReproducibilityError when builds diverge */
  throwOnMismatch?: boolean;
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/**
 * Error thrown when PCR reproducibility verification fails (builds diverge).
 * Contains both build results in the error message for CI debugging.
 */
export class PcrReproducibilityError extends ToonError {
  constructor(buildA: NixBuildResult, buildB: NixBuildResult) {
    super(
      `PCR reproducibility check failed: ` +
        `pcr0 buildA=${buildA.pcr0} buildB=${buildB.pcr0}, ` +
        `pcr1 buildA=${buildA.pcr1} buildB=${buildB.pcr1}, ` +
        `pcr2 buildA=${buildA.pcr2} buildB=${buildB.pcr2}`,
      'PCR_REPRODUCIBILITY_ERROR'
    );
    this.name = 'PcrReproducibilityError';
  }
}

// ---------------------------------------------------------------------------
// Dockerfile analysis
// ---------------------------------------------------------------------------

/**
 * Reads the content of a Dockerfile.nix file from disk.
 *
 * This is a thin I/O wrapper separated from the analysis function to keep
 * `analyzeDockerfileForNonDeterminism()` a pure function (no side effects).
 *
 * @param filePath - Absolute path to the Dockerfile.nix file
 * @returns The file content as a UTF-8 string
 */
export async function readDockerfileNix(filePath: string): Promise<string> {
  return readFile(filePath, 'utf-8');
}

/**
 * Analyzes a Dockerfile/Nix expression for non-deterministic patterns.
 *
 * This is a pure function -- it takes the file content as a string and an
 * array of forbidden patterns, and returns a structured report. No I/O is
 * performed; file reading is handled by `readDockerfileNix()`.
 *
 * Each line of the content is tested against every forbidden pattern. Lines
 * that start with '#' (comments) are skipped since they don't affect the
 * build output.
 *
 * @param content - The Dockerfile/Nix expression content as a string
 * @param forbiddenPatterns - Array of patterns that indicate non-determinism
 * @returns A DeterminismReport with violations and line numbers
 *
 * @example
 * ```typescript
 * const report = analyzeDockerfileForNonDeterminism(content, [
 *   { pattern: /apt-get\s+update/, name: 'apt-get update', reason: '...' },
 * ]);
 * if (!report.deterministic) {
 *   console.error('Violations:', report.violations);
 * }
 * ```
 */
export function analyzeDockerfileForNonDeterminism(
  content: string,
  forbiddenPatterns: ForbiddenPattern[]
): DeterminismReport {
  const lines = content.split('\n');
  const violations: Violation[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;

    // Skip comment-only lines (Nix uses # for comments, Dockerfiles use # too)
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue;

    for (const fp of forbiddenPatterns) {
      // Reset lastIndex to avoid stateful regex issues when callers
      // pass patterns with the global (g) flag set
      fp.pattern.lastIndex = 0;
      const match = fp.pattern.exec(line);
      if (match) {
        violations.push({
          line: i + 1, // 1-indexed line numbers
          patternName: fp.name,
          matchedText: match[0],
        });
      }
    }
  }

  return {
    deterministic: violations.length === 0,
    violations,
    scannedLines: lines.length,
  };
}

// ---------------------------------------------------------------------------
// PCR reproducibility verification
// ---------------------------------------------------------------------------

/**
 * Verifies that two NixBuildResults are reproducible -- i.e., they produce
 * identical PCR values and Docker image content hashes.
 *
 * This function is intended for CI pipelines: build the Docker image twice
 * from the same source tree, then call this function to verify the outputs
 * match. If they don't, the build is non-deterministic and PCR-based
 * attestation verification will fail.
 *
 * PCR values are normalized to lowercase before comparison to avoid
 * case-sensitivity issues.
 *
 * @param buildA - Result from the first build
 * @param buildB - Result from the second build
 * @param options - Optional: throwOnMismatch to throw PcrReproducibilityError
 * @returns A structured PcrReproducibilityResult with match details and summary
 *
 * Note: This function is async by API contract (Story 4.5 AC #4) to allow
 * future implementations to perform I/O (e.g., fetching PCR values from a
 * remote registry). The current implementation is synchronous.
 *
 * @example
 * ```typescript
 * const buildA = await builder.build();
 * const buildB = await builder.build();
 * const result = await verifyPcrReproducibility(buildA, buildB, {
 *   throwOnMismatch: true,
 * });
 * console.log(result.summary); // "PCR reproducibility: PASS ..."
 * ```
 */
export async function verifyPcrReproducibility(
  buildA: NixBuildResult,
  buildB: NixBuildResult,
  options?: VerifyOptions
): Promise<PcrReproducibilityResult> {
  // Normalize PCR values to lowercase for comparison
  const pcr0A = buildA.pcr0.toLowerCase();
  const pcr0B = buildB.pcr0.toLowerCase();
  const pcr1A = buildA.pcr1.toLowerCase();
  const pcr1B = buildB.pcr1.toLowerCase();
  const pcr2A = buildA.pcr2.toLowerCase();
  const pcr2B = buildB.pcr2.toLowerCase();
  const hashA = buildA.imageHash.toLowerCase();
  const hashB = buildB.imageHash.toLowerCase();

  const pcr0Match = pcr0A === pcr0B;
  const pcr1Match = pcr1A === pcr1B;
  const pcr2Match = pcr2A === pcr2B;
  const imageHashMatch = hashA === hashB;

  const reproducible = pcr0Match && pcr1Match && pcr2Match && imageHashMatch;

  // Build human-readable summary for CI logs
  const status = reproducible ? 'PASS' : 'FAIL';
  const summaryLines = [
    `PCR reproducibility: ${status}`,
    `  PCR0: ${pcr0Match ? 'match' : 'MISMATCH'} (${pcr0A})`,
    `  PCR1: ${pcr1Match ? 'match' : 'MISMATCH'} (${pcr1A})`,
    `  PCR2: ${pcr2Match ? 'match' : 'MISMATCH'} (${pcr2A})`,
    `  Image hash: ${imageHashMatch ? 'match' : 'MISMATCH'} (${hashA})`,
  ];

  if (!reproducible) {
    if (!pcr0Match) {
      summaryLines.push(`  PCR0 buildB: ${pcr0B}`);
    }
    if (!pcr1Match) {
      summaryLines.push(`  PCR1 buildB: ${pcr1B}`);
    }
    if (!pcr2Match) {
      summaryLines.push(`  PCR2 buildB: ${pcr2B}`);
    }
    if (!imageHashMatch) {
      summaryLines.push(`  Image hash buildB: ${hashB}`);
    }
  }

  const result: PcrReproducibilityResult = {
    reproducible,
    pcr0Match,
    pcr1Match,
    pcr2Match,
    imageHashMatch,
    details: {
      buildA: {
        pcr0: buildA.pcr0,
        pcr1: buildA.pcr1,
        pcr2: buildA.pcr2,
        imageHash: buildA.imageHash,
      },
      buildB: {
        pcr0: buildB.pcr0,
        pcr1: buildB.pcr1,
        pcr2: buildB.pcr2,
        imageHash: buildB.imageHash,
      },
    },
    summary: summaryLines.join('\n'),
  };

  if (!reproducible && options?.throwOnMismatch) {
    throw new PcrReproducibilityError(buildA, buildB);
  }

  return result;
}

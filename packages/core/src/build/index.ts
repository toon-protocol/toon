/**
 * Nix Reproducible Builds -- barrel exports
 *
 * Re-exports all public types, classes, and functions from the build module:
 *   - NixBuilder: Orchestrates Nix-based Docker image builds
 *   - PCR validator: Verifies build reproducibility and Dockerfile determinism
 *
 * @module
 */

// NixBuilder class and types
export { NixBuilder } from './nix-builder.js';
export type { NixBuildResult, NixBuilderConfig } from './nix-builder.js';

// PCR validation and Dockerfile analysis
export {
  verifyPcrReproducibility,
  readDockerfileNix,
  analyzeDockerfileForNonDeterminism,
  PcrReproducibilityError,
} from './pcr-validator.js';

export type {
  PcrReproducibilityResult,
  VerifyOptions,
  DeterminismReport,
  Violation,
  ForbiddenPattern,
} from './pcr-validator.js';

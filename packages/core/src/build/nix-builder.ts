/**
 * Nix Build Orchestration for Reproducible Docker Images
 *
 * The NixBuilder class wraps the `nix build` CLI invocation to produce
 * deterministic Docker images for TEE (Trusted Execution Environment)
 * deployment. Each build returns a NixBuildResult containing the image
 * hash, PCR (Platform Configuration Register) values, and Nix store path.
 *
 * PCR values are SHA-384 hashes measured by the TEE hardware from the
 * loaded image. If the Docker image is deterministic (identical content
 * hash across builds), then PCR values will also be identical -- enabling
 * remote attestation verification (Story 4.3 AttestationVerifier).
 *
 * IMPORTANT: The NixBuilder shells out to `nix build` -- it requires
 * the Nix package manager to be installed on the build machine. Tests
 * that exercise actual Nix builds should be conditionally skipped when
 * Nix is not available. Unit tests use mocked child_process.
 *
 * @module
 */

import { execFile as execFileCb } from 'node:child_process';
import { readFile, mkdtemp, cp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Promise wrapper for child_process.execFile. Uses a manual wrapper rather
 * than util.promisify so that the function can be reliably mocked in tests
 * (vi.mock of node:child_process replaces execFile with a vi.fn(), and
 * promisify at module scope captures the original before mock replacement).
 */
function execFileAsync(
  cmd: string,
  args: string[],
  options: { cwd?: string; timeout?: number }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFileCb(cmd, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
      }
    });
  });
}

/**
 * Result of a Nix build invocation.
 * Contains the Docker image content hash, PCR values derived from the image,
 * the Nix store path, and the build timestamp.
 */
export interface NixBuildResult {
  /** Docker image content hash (sha256:... -- 64 lowercase hex chars after prefix) */
  imageHash: string;
  /** PCR0 -- SHA-384 hash of the enclave image (96 lowercase hex chars) */
  pcr0: string;
  /** PCR1 -- SHA-384 hash of the kernel (96 lowercase hex chars) */
  pcr1: string;
  /** PCR2 -- SHA-384 hash of the application (96 lowercase hex chars) */
  pcr2: string;
  /** Path to the image in the Nix store (/nix/store/...) */
  imagePath: string;
  /** Unix timestamp (seconds since epoch) of the build */
  buildTimestamp: number;
}

/**
 * Configuration for the NixBuilder.
 */
export interface NixBuilderConfig {
  /** Root directory of the project (containing flake.nix) */
  projectRoot: string;
  /** Path to Dockerfile.nix relative to projectRoot */
  dockerfilePath: string;
  /**
   * Optional source overrides for testing. Keys are relative paths from
   * projectRoot, values are the file content to write. When set, NixBuilder
   * creates a temporary copy of the source tree with the overrides applied
   * before running the build. This allows testing that source changes
   * produce different PCR values.
   */
  sourceOverride?: Record<string, string>;
}

/**
 * Orchestrates Nix-based Docker image builds for reproducible TEE deployment.
 *
 * The build() method shells out to `nix build .#docker-image` and parses the
 * output to extract the image hash, Nix store path, and PCR values. PCR values
 * are computed from the image content using SHA-384 to simulate the measurement
 * that would be performed by the TEE hardware (AWS Nitro hypervisor).
 *
 * @example
 * ```typescript
 * const builder = new NixBuilder({
 *   projectRoot: '/path/to/toon',
 *   dockerfilePath: 'docker/Dockerfile.nix',
 * });
 * const result = await builder.build();
 * console.log(result.imageHash);  // sha256:abc123...
 * console.log(result.pcr0);       // 96-char hex string
 * ```
 */
export class NixBuilder {
  private readonly config: NixBuilderConfig;

  constructor(config: NixBuilderConfig) {
    this.config = config;
  }

  /**
   * Execute a Nix build and return the result.
   *
   * Shells out to `nix build .#docker-image` in the project root directory.
   * If sourceOverride is configured, creates a temporary modified source tree.
   *
   * @throws Error if Nix is not installed or the build fails
   */
  async build(): Promise<NixBuildResult> {
    let buildDir = this.config.projectRoot;
    let tempDir: string | undefined;

    try {
      // If source overrides are configured, create a temporary modified source tree
      if (this.config.sourceOverride) {
        tempDir = await mkdtemp(path.join(tmpdir(), 'toon-nix-'));
        await cp(this.config.projectRoot, tempDir, { recursive: true });

        for (const [relativePath, content] of Object.entries(
          this.config.sourceOverride
        )) {
          const fullPath = path.resolve(tempDir, relativePath);
          // Defense-in-depth: prevent path traversal outside the temp dir.
          // Use tempDir + path.sep to prevent prefix collision attacks where
          // a sibling directory shares the same prefix (e.g., tempDir is
          // /tmp/toon-nix-abc and path resolves to /tmp/toon-nix-abc123/).
          if (
            !fullPath.startsWith(tempDir + path.sep) &&
            fullPath !== tempDir
          ) {
            throw new Error(
              `sourceOverride path traversal detected: "${relativePath}" resolves outside temp directory`
            );
          }
          await writeFile(fullPath, content, 'utf-8');
        }

        buildDir = tempDir;
      }

      // Run nix build -- this produces a `result` symlink pointing to
      // the image in the Nix store
      const { stdout } = await execFileAsync(
        'nix',
        ['build', '.#docker-image', '--print-out-paths'],
        {
          cwd: buildDir,
          timeout: 600_000, // 10 minutes -- Nix builds can be slow on first run
        }
      );

      const imagePath = stdout.trim();

      // Validate the store path looks correct
      if (!imagePath.startsWith('/nix/store/')) {
        throw new Error(
          `Unexpected Nix build output path: ${imagePath} (expected /nix/store/...)`
        );
      }

      // Read the image file to compute hashes
      const imageData = await readFile(imagePath);

      // Compute Docker image content hash (SHA-256)
      const sha256 = createHash('sha256').update(imageData).digest('hex');
      const imageHash = `sha256:${sha256}`;

      // Compute PCR values (SHA-384) from the image content.
      // In the real Oyster CVM environment, PCR values are measured by the
      // AWS Nitro hypervisor from the loaded image. Here we simulate this
      // by computing SHA-384 of different aspects of the image:
      //   PCR0: SHA-384 of the entire image file (enclave image measurement)
      //   PCR1: SHA-384 of the first 1MB (kernel/boot region approximation)
      //   PCR2: SHA-384 of bytes after the first 1MB (application measurement)
      //
      // Note: For images <= 1MB, PCR1 === PCR0 (entire image fits in kernel
      // region) and PCR2 is computed over imageData with a domain separator
      // prefix to ensure PCR2 !== PCR0 even when the app region is empty.
      const pcr0 = createHash('sha384').update(imageData).digest('hex');

      const KERNEL_REGION_SIZE = 1024 * 1024;
      const kernelRegion = imageData.subarray(
        0,
        Math.min(KERNEL_REGION_SIZE, imageData.length)
      );
      const pcr1 = createHash('sha384').update(kernelRegion).digest('hex');

      const appRegion = imageData.subarray(
        Math.min(KERNEL_REGION_SIZE, imageData.length)
      );
      // When the image is <= 1MB the app region is empty. Use a domain
      // separator prefix ('pcr2:') so PCR2 is always distinct from PCR0.
      const pcr2 =
        appRegion.length > 0
          ? createHash('sha384').update(appRegion).digest('hex')
          : createHash('sha384')
              .update('pcr2:')
              .update(imageData)
              .digest('hex');

      return {
        imageHash,
        pcr0,
        pcr1,
        pcr2,
        imagePath,
        buildTimestamp: Math.floor(Date.now() / 1000),
      };
    } finally {
      // Clean up temporary directory if created
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {
          // Best-effort cleanup -- ignore errors
        });
      }
    }
  }
}

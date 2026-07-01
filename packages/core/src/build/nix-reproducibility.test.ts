/**
 * Policy guard: NixBuilder reproducibility invariant.
 *
 * Asserts that identical source inputs always produce identical hashes and
 * PCR values, and that any source mutation produces a different measurement.
 * This is the core TEE property: remote attesters rely on PCR values being
 * deterministic so they can verify the software running inside the enclave.
 *
 * All tests mock `node:child_process` (the `nix build` invocation) and
 * `node:fs/promises` (image file reads) so they run without Nix installed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Hoist mock fns so they are available when vi.mock factories run
// ---------------------------------------------------------------------------

const {
  mockExecFile,
  mockReadFile,
  mockMkdtemp,
  mockCp,
  mockWriteFile,
  mockRm,
} = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  mockReadFile: vi.fn(),
  mockMkdtemp: vi.fn(),
  mockCp: vi.fn(),
  mockWriteFile: vi.fn(),
  mockRm: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

vi.mock('node:fs/promises', () => ({
  readFile: mockReadFile,
  mkdtemp: mockMkdtemp,
  cp: mockCp,
  writeFile: mockWriteFile,
  rm: mockRm,
}));

import { NixBuilder } from './nix-builder.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_IMAGE_DATA = Buffer.from('fake-docker-image-content');
const FAKE_IMAGE_LARGE = Buffer.alloc(2 * 1024 * 1024, 0xab); // 2 MB
const NIX_STORE_PATH = '/nix/store/abc123-docker-image';

function pcr(data: Buffer): string {
  return createHash('sha384').update(data).digest('hex');
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function mockSuccessfulNixBuild(storePath: string, imageData: Buffer) {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: object, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      cb(null, storePath + '\n', '');
    }
  );
  mockReadFile.mockResolvedValue(imageData);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NixBuilder reproducibility policy guard', () => {
  const config = {
    projectRoot: '/fake/project',
    dockerfilePath: 'docker/Dockerfile.nix',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Core reproducibility invariant
  // -------------------------------------------------------------------------

  it('[P0] identical image data produces identical imageHash on two builds', async () => {
    mockSuccessfulNixBuild(NIX_STORE_PATH, FAKE_IMAGE_DATA);

    const builder = new NixBuilder(config);
    const result1 = await builder.build();
    const result2 = await builder.build();

    expect(result1.imageHash).toBe(result2.imageHash);
    expect(result1.imageHash).toBe(`sha256:${sha256(FAKE_IMAGE_DATA)}`);
  });

  it('[P0] identical image data produces identical PCR values on two builds', async () => {
    mockSuccessfulNixBuild(NIX_STORE_PATH, FAKE_IMAGE_DATA);

    const builder = new NixBuilder(config);
    const result1 = await builder.build();
    const result2 = await builder.build();

    expect(result1.pcr0).toBe(result2.pcr0);
    expect(result1.pcr1).toBe(result2.pcr1);
    expect(result1.pcr2).toBe(result2.pcr2);
  });

  it('[P0] different image data produces different imageHash (mutation detected)', async () => {
    const imageA = Buffer.from('image-version-alpha');
    const imageB = Buffer.from('image-version-beta');
    const builder = new NixBuilder(config);

    mockSuccessfulNixBuild(NIX_STORE_PATH, imageA);
    const resultA = await builder.build();

    mockSuccessfulNixBuild(NIX_STORE_PATH, imageB);
    const resultB = await builder.build();

    expect(resultA.imageHash).not.toBe(resultB.imageHash);
  });

  it('[P0] different image data produces different PCR0 (enclave measurement changes)', async () => {
    const imageA = Buffer.from('image-version-alpha');
    const imageB = Buffer.from('image-version-beta');
    const builder = new NixBuilder(config);

    mockSuccessfulNixBuild(NIX_STORE_PATH, imageA);
    const resultA = await builder.build();

    mockSuccessfulNixBuild(NIX_STORE_PATH, imageB);
    const resultB = await builder.build();

    expect(resultA.pcr0).not.toBe(resultB.pcr0);
  });

  // -------------------------------------------------------------------------
  // Hash algorithm correctness (PCR value shapes)
  // -------------------------------------------------------------------------

  it('[P1] imageHash is prefixed sha256: followed by 64 lowercase hex chars', async () => {
    mockSuccessfulNixBuild(NIX_STORE_PATH, FAKE_IMAGE_DATA);

    const result = await new NixBuilder(config).build();

    expect(result.imageHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('[P1] PCR values are 96 lowercase hex chars (SHA-384)', async () => {
    mockSuccessfulNixBuild(NIX_STORE_PATH, FAKE_IMAGE_DATA);

    const result = await new NixBuilder(config).build();

    expect(result.pcr0).toMatch(/^[0-9a-f]{96}$/);
    expect(result.pcr1).toMatch(/^[0-9a-f]{96}$/);
    expect(result.pcr2).toMatch(/^[0-9a-f]{96}$/);
  });

  it('[P1] PCR0 is SHA-384 of full image (enclave measurement)', async () => {
    mockSuccessfulNixBuild(NIX_STORE_PATH, FAKE_IMAGE_DATA);

    const result = await new NixBuilder(config).build();

    expect(result.pcr0).toBe(pcr(FAKE_IMAGE_DATA));
  });

  it('[P1] PCR1 equals PCR0 when image is <= 1 MB (kernel region = full image)', async () => {
    mockSuccessfulNixBuild(NIX_STORE_PATH, FAKE_IMAGE_DATA);

    const result = await new NixBuilder(config).build();

    expect(result.pcr1).toBe(pcr(FAKE_IMAGE_DATA));
    expect(result.pcr1).toBe(result.pcr0);
  });

  it('[P1] PCR1 is SHA-384 of first 1 MB when image is > 1 MB', async () => {
    mockSuccessfulNixBuild(NIX_STORE_PATH, FAKE_IMAGE_LARGE);

    const result = await new NixBuilder(config).build();

    const kernelRegion = FAKE_IMAGE_LARGE.subarray(0, 1024 * 1024);
    expect(result.pcr1).toBe(pcr(kernelRegion));
    expect(result.pcr1).not.toBe(result.pcr0);
  });

  it('[P1] PCR2 is SHA-384 of bytes after 1 MB when image is > 1 MB', async () => {
    mockSuccessfulNixBuild(NIX_STORE_PATH, FAKE_IMAGE_LARGE);

    const result = await new NixBuilder(config).build();

    const appRegion = FAKE_IMAGE_LARGE.subarray(1024 * 1024);
    expect(result.pcr2).toBe(pcr(appRegion));
  });

  it('[P1] PCR2 != PCR0 even when image is <= 1 MB (domain separator applied)', async () => {
    mockSuccessfulNixBuild(NIX_STORE_PATH, FAKE_IMAGE_DATA);

    const result = await new NixBuilder(config).build();

    // Implementation uses a 'pcr2:' domain separator so PCR2 can never
    // collide with PCR0 when the app region is empty.
    expect(result.pcr2).not.toBe(result.pcr0);
  });

  // -------------------------------------------------------------------------
  // Build output shape
  // -------------------------------------------------------------------------

  it('[P1] result includes imagePath from Nix store', async () => {
    mockSuccessfulNixBuild(NIX_STORE_PATH, FAKE_IMAGE_DATA);

    const result = await new NixBuilder(config).build();

    expect(result.imagePath).toBe(NIX_STORE_PATH);
  });

  it('[P1] build fails with clear error when Nix store path is unexpected', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        cb(null, '/unexpected/path/output\n', '');
      }
    );

    await expect(new NixBuilder(config).build()).rejects.toThrow(
      /unexpected nix build output path/i
    );
  });

  it('[P1] build propagates nix CLI errors as thrown exceptions', async () => {
    const nixError = new Error('nix build failed: derivation error');
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        cb(nixError, '', 'error output');
      }
    );

    await expect(new NixBuilder(config).build()).rejects.toThrow('nix build failed');
  });

  // -------------------------------------------------------------------------
  // sourceOverride: mutation detection
  // -------------------------------------------------------------------------

  it('[P0] sourceOverride with different content produces different PCR0', async () => {
    const TEMP_DIR = '/tmp/toon-nix-test123';
    mockMkdtemp.mockResolvedValue(TEMP_DIR);
    mockCp.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);

    const imageDataOriginal = Buffer.from('original-image-content');
    const imageDataModified = Buffer.from('modified-image-content');

    mockSuccessfulNixBuild(NIX_STORE_PATH, imageDataOriginal);
    const resultOriginal = await new NixBuilder(config).build();

    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
        cb(null, NIX_STORE_PATH + '\n', '');
      }
    );
    mockReadFile.mockResolvedValue(imageDataModified);

    const configWithOverride = {
      ...config,
      sourceOverride: { 'src/main.ts': 'export const VERSION = "2.0.0";' },
    };
    const resultModified = await new NixBuilder(configWithOverride).build();

    expect(resultOriginal.pcr0).not.toBe(resultModified.pcr0);
  });

  it('[P2] sourceOverride path traversal is rejected', async () => {
    const TEMP_DIR = '/tmp/toon-nix-abc';
    mockMkdtemp.mockResolvedValue(TEMP_DIR);
    mockCp.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);

    const configWithTraversal = {
      ...config,
      sourceOverride: { '../../../etc/passwd': 'hacked' },
    };

    await expect(new NixBuilder(configWithTraversal).build()).rejects.toThrow(
      /path traversal/i
    );
  });
});

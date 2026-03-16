/**
 * ATDD tests for Story 3.1: USDC Token Migration (FR-PROD-1)
 *
 * Validates:
 * - Mock USDC module exports correct address and config
 * - TokenNetwork address exported correctly for USDC
 * - Faucet distributes mock USDC instead of AGENT
 * - All references to "AGENT" token replaced with "USDC"
 * - Pricing denomination is USDC micro-units (6 decimals)
 * - USDC constants re-exported from @crosstown/core public API
 * - BLS/Docker source files also free of AGENT references
 * - Deploy scripts reference USDC in user-facing output
 * - basePricePerByte documentation updated to USDC denomination
 * - Environment files updated with USDC references
 *
 * Test IDs from test-design-epic-3.md:
 * - T-3.1-01 / 3.1-INT-001 [P0]: Mock USDC module exports (unit-level; on-chain EIP-3009 deferred to Story 3.3)
 * - T-3.1-02 / 3.1-INT-001 [P0]: USDC address matches TokenNetwork token (unit-level; on-chain openChannel deferred to E2E)
 * - T-3.1-03 / 3.1-UNIT-001 [P2]: Faucet distributes mock USDC
 * - T-3.1-04 / 3.1-UNIT-002 [P2]: "AGENT" references removed (static analysis)
 * - T-3.1-05 [P1]: basePricePerByte pricing produces USDC micro-unit amounts
 * - T-3.1-06 [P1]: Pricing validator accepts/rejects USDC micro-unit amounts (in pricing-validator.test.ts)
 * - T-3.1-07 [P2]: USDC constants re-exported from core package index
 * - T-3.1-08 [P2]: No AGENT references in BLS/Docker source files
 * - T-3.1-09 [P2]: Deploy scripts reference USDC instead of AGENT
 * - T-3.1-10 [P2]: basePricePerByte config has USDC denomination docs
 * - T-3.1-15 [P2]: Environment files (.env) reference USDC instead of AGENT
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MOCK_USDC_ADDRESS,
  USDC_DECIMALS,
  USDC_SYMBOL,
  USDC_NAME,
  MOCK_USDC_CONFIG,
} from './usdc.js';
import type { MockUsdcConfig } from './usdc.js';

// ============================================================================
// Constants
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const monoRoot = resolve(__dirname, '../../../..');

/** Old AGENT token address — must NOT appear in non-USDC source after migration. */
const OLD_AGENT_TOKEN_ADDRESS = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Recursively collect .ts files from a directory, excluding test files,
 * __integration__/ directories, and node_modules.
 */
function collectSourceFiles(dir: string): string[] {
  const results: string[] = [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = resolve(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      // Skip excluded directories
      if (
        entry === 'node_modules' ||
        entry === '__integration__' ||
        entry === 'dist' ||
        entry === 'coverage'
      ) {
        continue;
      }
      results.push(...collectSourceFiles(fullPath));
    } else if (stat.isFile() && entry.endsWith('.ts')) {
      // Skip test files
      if (entry.endsWith('.test.ts')) continue;
      results.push(fullPath);
    }
  }

  return results;
}

// ============================================================================
// Tests
// ============================================================================

describe('Story 3.1: USDC Token Migration', () => {
  // --------------------------------------------------------------------------
  // T-3.1-01 / 3.1-INT-001 [P0]: Mock USDC module exports
  // Risk: E3-R001 (Mock USDC fidelity)
  //
  // NOTE: Full EIP-3009 transferWithAuthorization verification requires
  // Anvil running (integration test). This unit test verifies the mock
  // USDC module exports correct address, config, and EIP-3009-compatible
  // metadata. On-chain EIP-3009 testing is deferred to Story 3.3.
  // --------------------------------------------------------------------------
  describe('Mock USDC module exports (3.1-INT-001)', () => {
    it('[P0] mock USDC module exports correct address and EIP-3009 compatible config', () => {
      // Verify USDC module exports correct address (deterministic Anvil nonce 0)
      expect(MOCK_USDC_ADDRESS).toBe(
        '0x5FbDB2315678afecb367f032d93F642f64180aa3'
      );

      // Verify USDC uses 6 decimals (required for EIP-3009 amount encoding)
      expect(USDC_DECIMALS).toBe(6);

      // Verify config object is complete and self-consistent
      const config: MockUsdcConfig = MOCK_USDC_CONFIG;
      expect(config.address).toBe(MOCK_USDC_ADDRESS);
      expect(config.decimals).toBe(USDC_DECIMALS);
      expect(config.symbol).toBe('USDC');
      expect(config.name).toBe('USD Coin');

      // NOTE: Full EIP-3009 on-chain verification (transferWithAuthorization)
      // deferred to Story 3.3 integration tests that require Anvil.
    });

    // --------------------------------------------------------------------------
    // T-3.1-02 / 3.1-INT-001 [P0]: USDC address matches TokenNetwork token
    //
    // NOTE: On-chain openChannel verification requires Anvil running.
    // This unit test verifies the USDC address is a valid Ethereum address
    // at the expected deterministic deployment slot, confirming the
    // TokenNetwork (created for this address) will work with USDC.
    // --------------------------------------------------------------------------
    it('[P0] USDC address matches deterministic TokenNetwork token address', () => {
      // The mock USDC deploys at the same Anvil nonce-0 address as the former
      // AGENT token. The TokenNetwork at 0xCafac3dD18aC6c6e92c921884f9E4176737C052c
      // was created for whichever token deploys at this address.
      expect(MOCK_USDC_ADDRESS).toBe(OLD_AGENT_TOKEN_ADDRESS);

      // Verify the address is a valid Ethereum address format
      expect(MOCK_USDC_ADDRESS).toMatch(/^0x[0-9a-fA-F]{40}$/);

      // Verify USDC metadata is correct for channel operations
      expect(USDC_SYMBOL).toBe('USDC');
      expect(USDC_DECIMALS).toBe(6);

      // NOTE: Full on-chain openChannel verification deferred to E2E tests
      // that require Anvil infrastructure.
    });
  });

  // --------------------------------------------------------------------------
  // T-3.1-03 / 3.1-UNIT-001 [P2]: Faucet distributes mock USDC
  // --------------------------------------------------------------------------
  describe('Faucet USDC distribution (3.1-UNIT-001)', () => {
    it('[P2] faucet config specifies USDC token instead of AGENT', () => {
      // Arrange — read the faucet source file
      const faucetPath = resolve(monoRoot, 'packages/faucet/src/index.js');
      const faucetSource = readFileSync(faucetPath, 'utf-8');

      // Verify default tokenSymbol is 'USDC' (not 'AGENT')
      expect(faucetSource).toContain("tokenSymbol = 'USDC'");
      expect(faucetSource).not.toContain("tokenSymbol = 'AGENT'");

      // Verify default tokenDecimals is 6 (not 18)
      expect(faucetSource).toContain('tokenDecimals = 6');
      expect(faucetSource).not.toContain('tokenDecimals = 18');

      // Verify TOKEN_AMOUNT comment says USDC (not AGENT)
      expect(faucetSource).not.toMatch(/10,000 AGENT/);
      expect(faucetSource).toContain('10,000 USDC');
    });
  });

  // --------------------------------------------------------------------------
  // T-3.1-04 / 3.1-UNIT-002 [P2]: "AGENT" references removed
  // Pattern: "verification by absence" (same as Story 2-7 SPSP removal)
  // --------------------------------------------------------------------------
  describe('AGENT token references removed (3.1-UNIT-002)', () => {
    it('[P2] no AGENT token references in config types', () => {
      // Scan source files in packages/{core,sdk,town,bls}/src/
      // excluding test files, __integration__/, and the usdc.ts module itself.
      //
      // BLS entrypoint.ts is excluded because it uses the address as a
      // runtime fallback (the BLS package is a Docker service that doesn't
      // import from @crosstown/core at runtime). The address there is
      // documented as "Mock USDC (Anvil deterministic address)".
      const scanDirs = [
        resolve(monoRoot, 'packages/core/src'),
        resolve(monoRoot, 'packages/sdk/src'),
        resolve(monoRoot, 'packages/town/src'),
        resolve(monoRoot, 'packages/bls/src'),
      ];

      // Files that legitimately contain the address with documented reasons
      const allowedFiles = new Set([
        'packages/core/src/chain/usdc.ts', // Source of truth for MOCK_USDC_ADDRESS
        'packages/bls/src/entrypoint.ts', // Runtime fallback (Docker, no core import)
      ]);

      const sourceFiles: { path: string; content: string }[] = [];

      for (const dir of scanDirs) {
        const files = collectSourceFiles(dir);
        for (const filePath of files) {
          const rel = relative(monoRoot, filePath);
          if (allowedFiles.has(rel)) continue;

          const content = readFileSync(filePath, 'utf-8');
          sourceFiles.push({ path: rel, content });
        }
      }

      // Verify we actually scanned some files (sanity check)
      expect(sourceFiles.length).toBeGreaterThan(0);

      // Check for the old AGENT token address in non-allowed source files
      // The address now represents USDC and should only be defined in usdc.ts
      // (or used as a fallback in entrypoint.ts)
      const violations = sourceFiles.filter(({ content }) =>
        content.includes(OLD_AGENT_TOKEN_ADDRESS)
      );

      // Provide actionable error messages if violations exist
      if (violations.length > 0) {
        const violationPaths = violations
          .map(({ path }) => `  - ${path}`)
          .join('\n');
        expect.fail(
          `Old AGENT token address found in ${violations.length} source file(s):\n${violationPaths}\n\n` +
            `The address ${OLD_AGENT_TOKEN_ADDRESS} should only appear in:\n` +
            `  - packages/core/src/chain/usdc.ts (MOCK_USDC_ADDRESS)\n` +
            `  - packages/bls/src/entrypoint.ts (runtime fallback)\n` +
            `All other references should import from the usdc module.`
        );
      }

      expect(violations).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // T-3.1-05 [P1]: USDC denomination pricing
  // AC: #2 — basePricePerByte pricing produces USDC micro-unit amounts
  //
  // NOTE: The pricing formula is denomination-agnostic (bigint * bigint).
  // This test documents USDC-specific economic semantics and verifies
  // the amounts make sense in USDC's 6-decimal context. The actual
  // createPricingValidator integration tests are in T-3.1-06
  // (pricing-validator.test.ts).
  // --------------------------------------------------------------------------
  describe('USDC denomination pricing (T-3.1-05)', () => {
    it('[P1] basePricePerByte pricing produces amounts in USDC micro-units', () => {
      // With USDC (6 decimals), basePricePerByte = 10n means 10 micro-USDC per byte.
      //
      // USDC denomination semantics:
      //   - 1 USDC = 1,000,000 micro-USDC (10^6)
      //   - basePricePerByte = 10n = 10 micro-USDC per byte = $0.00001/byte
      //   - A 1KB event costs: 1024 * 10 = 10,240 micro-USDC = $0.01024

      const basePricePerByte = 10n;
      const toonLength = 1024; // 1KB event

      // Compute expected amount in USDC micro-units
      const expectedAmount = basePricePerByte * BigInt(toonLength);
      expect(expectedAmount).toBe(10240n);

      // Verify the dollar amount makes economic sense for micropayments
      // 10240 micro-USDC = 0.010240 USDC = ~$0.01
      const usdcDollars = Number(expectedAmount) / 10 ** USDC_DECIMALS;
      expect(usdcDollars).toBeCloseTo(0.01024, 5);

      // Verify USDC_DECIMALS is 6 (the conversion factor)
      expect(USDC_DECIMALS).toBe(6);

      // Verify underpayment by 1 micro-USDC is detectable
      const underpayment = expectedAmount - 1n;
      expect(underpayment).toBe(10239n);
      expect(underpayment).toBeLessThan(expectedAmount);

      // Verify larger events scale linearly
      const largeEventLength = 10 * 1024; // 10KB
      const largeAmount = basePricePerByte * BigInt(largeEventLength);
      const largeDollars = Number(largeAmount) / 10 ** USDC_DECIMALS;
      expect(largeDollars).toBeCloseTo(0.1024, 4); // ~$0.10
    });
  });

  // --------------------------------------------------------------------------
  // Bonus: USDC module type safety
  // --------------------------------------------------------------------------
  describe('USDC module exports', () => {
    it('exports all required constants and types', () => {
      // Constants
      expect(typeof MOCK_USDC_ADDRESS).toBe('string');
      expect(typeof USDC_DECIMALS).toBe('number');
      expect(typeof USDC_SYMBOL).toBe('string');
      expect(typeof USDC_NAME).toBe('string');

      // Config object
      expect(MOCK_USDC_CONFIG).toEqual({
        address: MOCK_USDC_ADDRESS,
        decimals: USDC_DECIMALS,
        symbol: USDC_SYMBOL,
        name: USDC_NAME,
      });

      // Type check (compile-time verification)
      const _typeCheck: MockUsdcConfig = MOCK_USDC_CONFIG;
      expect(_typeCheck).toBeDefined();
    });
  });

  // ==========================================================================
  // Gap-filling tests: acceptance criteria not previously covered
  // ==========================================================================

  // --------------------------------------------------------------------------
  // T-3.1-07 [P2]: USDC constants re-exported from @crosstown/core public API
  // AC: #1, #4 — downstream packages must be able to import USDC config
  // --------------------------------------------------------------------------
  describe('USDC public API re-exports (T-3.1-07)', () => {
    it('[P2] @crosstown/core index.ts re-exports all USDC constants', () => {
      // Arrange — read the core package index.ts
      const indexPath = resolve(monoRoot, 'packages/core/src/index.ts');
      const indexSource = readFileSync(indexPath, 'utf-8');

      // Assert all USDC exports are present in the public API
      expect(indexSource).toContain('MOCK_USDC_ADDRESS');
      expect(indexSource).toContain('USDC_DECIMALS');
      expect(indexSource).toContain('USDC_SYMBOL');
      expect(indexSource).toContain('USDC_NAME');
      expect(indexSource).toContain('MOCK_USDC_CONFIG');
      expect(indexSource).toContain('MockUsdcConfig');

      // Verify the import source is the usdc module
      expect(indexSource).toContain("from './chain/usdc.js'");
    });
  });

  // --------------------------------------------------------------------------
  // T-3.1-08 [P2]: No AGENT references in BLS and Docker source files
  // AC: #4 — extends T-3.1-04 to cover BLS and Docker packages
  //
  // The original T-3.1-04 only scans packages/{core,sdk,town}/src/.
  // AC #4 says "all references to AGENT token are replaced" which
  // includes BLS and Docker source files.
  // --------------------------------------------------------------------------
  describe('AGENT references absent from BLS and Docker (T-3.1-08)', () => {
    it('[P2] no AGENT token name references in BLS source files', () => {
      const blsSrcDir = resolve(monoRoot, 'packages/bls/src');
      const sourceFiles = collectSourceFiles(blsSrcDir);

      expect(sourceFiles.length).toBeGreaterThan(0);

      // Check for "AGENT" as a token denomination reference (case-sensitive)
      // Excludes comments that say "Mock USDC" near the address (which replaced AGENT)
      const violations: string[] = [];
      for (const filePath of sourceFiles) {
        const content = readFileSync(filePath, 'utf-8');
        const rel = relative(monoRoot, filePath);

        // Check for AGENT as a standalone token name (not part of other words)
        // Pattern: AGENT preceded/followed by word boundary contexts
        // e.g., "AGENT token", "AGENT_TOKEN", "'AGENT'", but not "UserAgent"
        if (/\bAGENT\b/.test(content)) {
          violations.push(rel);
        }
      }

      if (violations.length > 0) {
        expect.fail(
          `AGENT token reference found in BLS source file(s):\n` +
            violations.map((p) => `  - ${p}`).join('\n') +
            `\n\nAll AGENT references should be replaced with USDC.`
        );
      }

      expect(violations).toHaveLength(0);
    });

    it('[P2] no AGENT token name references in Docker source files', () => {
      const dockerSrcDir = resolve(monoRoot, 'docker/src');
      const sourceFiles = collectSourceFiles(dockerSrcDir);

      expect(sourceFiles.length).toBeGreaterThan(0);

      const violations: string[] = [];
      for (const filePath of sourceFiles) {
        const content = readFileSync(filePath, 'utf-8');
        const rel = relative(monoRoot, filePath);

        if (/\bAGENT\b/.test(content)) {
          violations.push(rel);
        }
      }

      if (violations.length > 0) {
        expect.fail(
          `AGENT token reference found in Docker source file(s):\n` +
            violations.map((p) => `  - ${p}`).join('\n') +
            `\n\nAll AGENT references should be replaced with USDC.`
        );
      }

      expect(violations).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // T-3.1-09 [P2]: Deploy scripts reference USDC instead of AGENT
  // AC: #4 — positive verification that migration is reflected in scripts
  // --------------------------------------------------------------------------
  describe('Deploy scripts USDC references (T-3.1-09)', () => {
    it('[P2] deploy-genesis-node.sh references USDC in user-facing output', () => {
      const scriptPath = resolve(monoRoot, 'deploy-genesis-node.sh');
      const scriptSource = readFileSync(scriptPath, 'utf-8');

      // Positive: script mentions USDC
      expect(scriptSource).toContain('USDC');

      // Negative: script does NOT mention AGENT as token name
      expect(scriptSource).not.toMatch(/\bAGENT\b/);
    });

    it('[P2] deploy-peers.sh references USDC in user-facing output', () => {
      const scriptPath = resolve(monoRoot, 'deploy-peers.sh');
      const scriptSource = readFileSync(scriptPath, 'utf-8');

      // Positive: script mentions USDC
      expect(scriptSource).toContain('USDC');

      // Negative: script does NOT mention AGENT as token name
      expect(scriptSource).not.toMatch(/\bAGENT\b/);
    });

    it('[P2] fund-peer-wallet.sh references USDC in user-facing output', () => {
      const scriptPath = resolve(monoRoot, 'fund-peer-wallet.sh');
      const scriptSource = readFileSync(scriptPath, 'utf-8');

      // Positive: script mentions USDC
      expect(scriptSource).toContain('USDC');

      // Negative: script does NOT mention AGENT as token name
      expect(scriptSource).not.toMatch(/\bAGENT\b/);
    });
  });

  // --------------------------------------------------------------------------
  // T-3.1-10 [P2]: basePricePerByte config has USDC denomination docs
  // AC: #2 — SDK create-node.ts documents USDC denomination for pricing
  // --------------------------------------------------------------------------
  describe('SDK pricing USDC documentation (T-3.1-10)', () => {
    it('[P2] basePricePerByte config field documents USDC micro-units', () => {
      // Arrange — read the SDK create-node.ts source
      const createNodePath = resolve(
        monoRoot,
        'packages/sdk/src/create-node.ts'
      );
      const source = readFileSync(createNodePath, 'utf-8');

      // Verify USDC denomination documentation exists near basePricePerByte
      expect(source).toContain('USDC micro-units');
      expect(source).toContain('micro-USDC per byte');

      // Verify the documentation mentions 6 decimals
      expect(source).toContain('6 decimals');
    });
  });

  // --------------------------------------------------------------------------
  // T-3.1-11 [P2]: docker-compose files reference USDC instead of AGENT
  // AC: #1, #4 — token address configs and comments updated
  // --------------------------------------------------------------------------
  describe('Docker Compose USDC references (T-3.1-11)', () => {
    it('[P2] docker-compose-genesis.yml has no AGENT references', () => {
      const composePath = resolve(monoRoot, 'docker-compose-genesis.yml');
      const composeSource = readFileSync(composePath, 'utf-8');

      // Verify no AGENT references remain
      expect(composeSource).not.toMatch(/\bAGENT\b/);

      // Positive: contains USDC references
      expect(composeSource).toContain('USDC');
    });

    it('[P2] docker-compose-sdk-e2e.yml has no AGENT references', () => {
      const composePath = resolve(monoRoot, 'docker-compose-sdk-e2e.yml');
      const composeSource = readFileSync(composePath, 'utf-8');

      // Verify no AGENT references remain
      expect(composeSource).not.toMatch(/\bAGENT\b/);
    });
  });

  // --------------------------------------------------------------------------
  // T-3.1-12 [P2]: Example files reference USDC instead of AGENT
  // AC: #4 — all example files updated per Task 4
  // --------------------------------------------------------------------------
  describe('Example files USDC references (T-3.1-12)', () => {
    it('[P2] no example file references AGENT token', () => {
      const examplesDir = resolve(monoRoot, 'examples');
      const clientExamplesDir = resolve(monoRoot, 'packages/client/examples');

      // Collect all .ts files from examples directories
      const allExampleFiles: string[] = [];

      for (const dir of [examplesDir, clientExamplesDir]) {
        try {
          const files = collectSourceFiles(dir);
          allExampleFiles.push(...files);
        } catch {
          // Directory may not exist
        }
      }

      expect(allExampleFiles.length).toBeGreaterThan(0);

      const violations: string[] = [];
      for (const filePath of allExampleFiles) {
        const content = readFileSync(filePath, 'utf-8');
        const rel = relative(monoRoot, filePath);

        if (/\bAGENT\b/.test(content)) {
          violations.push(rel);
        }
      }

      if (violations.length > 0) {
        expect.fail(
          `AGENT reference found in example file(s):\n` +
            violations.map((p) => `  - ${p}`).join('\n') +
            `\n\nAll AGENT references in examples should be replaced with USDC.`
        );
      }

      expect(violations).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // T-3.1-13 [P2]: Faucet source has no AGENT string references
  // AC: #3 — extends T-3.1-03 to verify no AGENT word references remain
  // --------------------------------------------------------------------------
  describe('Faucet AGENT reference absence (T-3.1-13)', () => {
    it('[P2] faucet source has no AGENT token name references', () => {
      const faucetPath = resolve(monoRoot, 'packages/faucet/src/index.js');
      const faucetSource = readFileSync(faucetPath, 'utf-8');

      // No AGENT as a standalone word (token name context)
      expect(faucetSource).not.toMatch(/\bAGENT\b/);
    });
  });

  // --------------------------------------------------------------------------
  // T-3.1-14 [P2]: Documentation references USDC instead of AGENT
  // AC: #4 — docs/settlement.md updated
  // --------------------------------------------------------------------------
  describe('Documentation USDC references (T-3.1-14)', () => {
    it('[P2] docs/settlement.md references USDC instead of AGENT', () => {
      const docPath = resolve(monoRoot, 'docs/settlement.md');
      const docSource = readFileSync(docPath, 'utf-8');

      // No AGENT references in any case combination
      expect(docSource).not.toMatch(/\bAGENT\b/);

      // Positive: mentions USDC
      expect(docSource).toContain('USDC');
    });
  });

  // --------------------------------------------------------------------------
  // T-3.1-15 [P2]: Environment files reference USDC instead of AGENT
  // AC: #4 — .env and packages/sdk/.env updated
  // --------------------------------------------------------------------------
  describe('Environment files USDC references (T-3.1-15)', () => {
    it('[P2] root .env has no AGENT references', () => {
      const envPath = resolve(monoRoot, '.env');
      if (!existsSync(envPath)) return; // .env is gitignored; skip in CI
      const envSource = readFileSync(envPath, 'utf-8');

      // No AGENT as a standalone word (token name context)
      expect(envSource).not.toMatch(/\bAGENT\b/);
    });

    it('[P2] packages/sdk/.env has no AGENT references', () => {
      const envPath = resolve(monoRoot, 'packages/sdk/.env');
      if (!existsSync(envPath)) return; // .env is gitignored; skip in CI
      const envSource = readFileSync(envPath, 'utf-8');

      // No AGENT as a standalone word (token name context)
      expect(envSource).not.toMatch(/\bAGENT\b/);
    });
  });
});

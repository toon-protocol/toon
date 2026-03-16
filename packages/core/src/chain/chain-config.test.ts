/**
 * ATDD tests for Story 3.2: Multi-Environment Chain Configuration (FR-PROD-2)
 *
 * Validates:
 * - resolveChainConfig() returns correct values for all 3 chain presets
 * - resolveChainConfig() defaults to 'anvil' when no argument provided
 * - Environment variable overrides (CROSSTOWN_CHAIN, CROSSTOWN_RPC_URL, CROSSTOWN_TOKEN_NETWORK)
 * - Invalid chain name produces clear error
 * - ChainPreset type completeness
 * - Defensive copy (returned object is not shared reference)
 * - EIP-712 domain separator uses resolved chainId (not hardcoded)
 * - No ethers imports in Epic 3 code (viem-only enforcement)
 *
 * Test IDs from test-design-epic-3.md:
 * - 3.2-UNIT-001 [P0]: Chain preset correctness (3 tests + default-to-anvil)
 * - 3.2-UNIT-002 [P1]: Env var overrides (CROSSTOWN_CHAIN, CROSSTOWN_RPC_URL, CROSSTOWN_TOKEN_NETWORK)
 * - 3.2-UNIT-003 [P1]: Invalid chain name
 * - 3.2-UNIT-004 [P2]: Preset type completeness + defensive copy
 * - 3.9-UNIT-001 [P2]: viem-only enforcement (static analysis)
 * - 3.2-INT-001 [P0]: EIP-712 chain-awareness (2 tests)
 *
 * Total: 21 tests (13 from ATDD checklist + 8 additional coverage)
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  resolveChainConfig,
  buildEip712Domain,
  CHAIN_PRESETS,
} from './chain-config.js';
import type { ChainPreset } from './chain-config.js';
import { MOCK_USDC_ADDRESS } from './usdc.js';
import { CrosstownError } from '../errors.js';

// ============================================================================
// Constants -- expected chain preset values
// ============================================================================

/** Known Arbitrum One USDC address (per Story 3.2 spec). */
const ARBITRUM_ONE_USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';

/** Known Arbitrum Sepolia (Circle testnet) USDC address. */
const ARBITRUM_SEPOLIA_USDC = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d';

/** Anvil deterministic chain ID. */
const ANVIL_CHAIN_ID = 31337;

/** Arbitrum Sepolia chain ID. */
const ARBITRUM_SEPOLIA_CHAIN_ID = 421614;

/** Arbitrum One chain ID. */
const ARBITRUM_ONE_CHAIN_ID = 42161;

/** Anvil deterministic TokenNetwork address. */
const ANVIL_TOKEN_NETWORK = '0xCafac3dD18aC6c6e92c921884f9E4176737C052c';

/** Arbitrum Sepolia public RPC endpoint. */
const ARBITRUM_SEPOLIA_RPC = 'https://sepolia-rollup.arbitrum.io/rpc';

/** Arbitrum One public RPC endpoint. */
const ARBITRUM_ONE_RPC = 'https://arb1.arbitrum.io/rpc';

// ============================================================================
// Helper: recursive file scan for static analysis tests
// ============================================================================

function collectSourceFiles(dir: string, exclude: RegExp): string[] {
  const files: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      files.push(...collectSourceFiles(fullPath, exclude));
    } else if (entry.endsWith('.ts') && !exclude.test(entry)) {
      files.push(fullPath);
    }
  }
  return files;
}

// ============================================================================
// Tests
// ============================================================================

describe('Story 3.2: Multi-Environment Chain Configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // --------------------------------------------------------------------------
  // 3.2-UNIT-001 [P0]: Chain preset correctness
  // Risk: E3-R004 (Chain config injection)
  // --------------------------------------------------------------------------
  describe('Chain preset correctness (3.2-UNIT-001)', () => {
    it('[P0] resolveChainConfig("anvil") returns local Anvil preset', () => {
      const config = resolveChainConfig('anvil');

      expect(config.chainId).toBe(ANVIL_CHAIN_ID);
      expect(config.rpcUrl).toBe('http://localhost:8545');
      expect(config.usdcAddress).toBe(MOCK_USDC_ADDRESS);
      expect(config.tokenNetworkAddress).toBe(ANVIL_TOKEN_NETWORK);
      expect(config.name).toBe('anvil');
    });

    it('[P0] resolveChainConfig("arbitrum-sepolia") returns testnet preset', () => {
      const config = resolveChainConfig('arbitrum-sepolia');

      expect(config.chainId).toBe(ARBITRUM_SEPOLIA_CHAIN_ID);
      expect(config.rpcUrl).toBe(ARBITRUM_SEPOLIA_RPC);
      expect(config.usdcAddress).toBe(ARBITRUM_SEPOLIA_USDC);
      expect(config.tokenNetworkAddress).toBe('');
      expect(config.name).toBe('arbitrum-sepolia');
    });

    it('[P0] resolveChainConfig("arbitrum-one") returns production preset', () => {
      const config = resolveChainConfig('arbitrum-one');

      expect(config.chainId).toBe(ARBITRUM_ONE_CHAIN_ID);
      expect(config.rpcUrl).toBe(ARBITRUM_ONE_RPC);
      expect(config.usdcAddress).toBe(ARBITRUM_ONE_USDC);
      expect(config.tokenNetworkAddress).toBe('');
      expect(config.name).toBe('arbitrum-one');
    });

    it('[P1] resolveChainConfig() defaults to anvil when no argument provided', () => {
      const config = resolveChainConfig();

      expect(config.chainId).toBe(ANVIL_CHAIN_ID);
      expect(config.name).toBe('anvil');
      expect(config.rpcUrl).toBe('http://localhost:8545');
    });
  });

  // --------------------------------------------------------------------------
  // 3.2-UNIT-002 [P1]: Env var overrides
  // --------------------------------------------------------------------------
  describe('Environment variable overrides (3.2-UNIT-002)', () => {
    it('[P1] CROSSTOWN_CHAIN env var overrides config file chain selection', () => {
      vi.stubEnv('CROSSTOWN_CHAIN', 'arbitrum-one');

      const config = resolveChainConfig('anvil'); // config says anvil, env says arbitrum-one

      expect(config.chainId).toBe(ARBITRUM_ONE_CHAIN_ID); // env wins
      expect(config.name).toBe('arbitrum-one');
    });

    it('[P1] CROSSTOWN_RPC_URL env var overrides preset RPC endpoint', () => {
      const customRpc = 'https://custom-rpc.example.com';
      vi.stubEnv('CROSSTOWN_RPC_URL', customRpc);

      const config = resolveChainConfig('arbitrum-one');

      expect(config.rpcUrl).toBe(customRpc);
      expect(config.chainId).toBe(ARBITRUM_ONE_CHAIN_ID); // other fields unchanged
    });

    it('[P1] CROSSTOWN_TOKEN_NETWORK env var overrides preset tokenNetworkAddress', () => {
      const customTokenNetwork = '0x1234567890abcdef1234567890abcdef12345678';
      vi.stubEnv('CROSSTOWN_TOKEN_NETWORK', customTokenNetwork);

      const config = resolveChainConfig('anvil');

      expect(config.tokenNetworkAddress).toBe(customTokenNetwork);
      expect(config.chainId).toBe(ANVIL_CHAIN_ID); // other fields unchanged
      expect(config.rpcUrl).toBe('http://localhost:8545'); // other fields unchanged
    });
  });

  // --------------------------------------------------------------------------
  // 3.2-UNIT-003 [P1]: Invalid chain name
  // --------------------------------------------------------------------------
  describe('Invalid chain name (3.2-UNIT-003)', () => {
    it('[P1] unknown chain name throws clear error message', () => {
      expect(() => resolveChainConfig('invalid-chain')).toThrow(
        /unknown chain.*invalid-chain/i
      );
    });

    it('[P1] error message lists all valid chain names', () => {
      try {
        resolveChainConfig('bogus');
        expect.fail('Expected resolveChainConfig to throw');
      } catch (error: unknown) {
        const message = (error as Error).message;
        expect(message).toContain('anvil');
        expect(message).toContain('arbitrum-sepolia');
        expect(message).toContain('arbitrum-one');
      }
    });

    it('[P1] throws CrosstownError with INVALID_CHAIN error code', () => {
      try {
        resolveChainConfig('nonexistent');
        expect.fail('Expected resolveChainConfig to throw');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(CrosstownError);
        expect((error as CrosstownError).code).toBe('INVALID_CHAIN');
      }
    });

    it('[P1] CROSSTOWN_CHAIN env var with invalid value throws clear error', () => {
      vi.stubEnv('CROSSTOWN_CHAIN', 'invalid-env-chain');

      expect(() => resolveChainConfig()).toThrow(
        /unknown chain.*invalid-env-chain/i
      );
    });
  });

  // --------------------------------------------------------------------------
  // 3.2-UNIT-004 [P2]: Preset type completeness
  // --------------------------------------------------------------------------
  describe('Preset type completeness (3.2-UNIT-004)', () => {
    it('[P2] ChainPreset has all required fields: chainId, rpcUrl, usdcAddress, tokenNetworkAddress, name', () => {
      const config: ChainPreset = resolveChainConfig('anvil');

      expect(config).toHaveProperty('chainId');
      expect(config).toHaveProperty('rpcUrl');
      expect(config).toHaveProperty('usdcAddress');
      expect(config).toHaveProperty('tokenNetworkAddress');
      expect(config).toHaveProperty('name');
      expect(typeof config.chainId).toBe('number');
      expect(typeof config.rpcUrl).toBe('string');
      expect(typeof config.usdcAddress).toBe('string');
      expect(typeof config.tokenNetworkAddress).toBe('string');
      expect(typeof config.name).toBe('string');
    });

    it('[P2] resolveChainConfig() returns defensive copy, not shared reference', () => {
      const config1 = resolveChainConfig('anvil');
      const config2 = resolveChainConfig('anvil');

      // Should be equal in value but not the same object reference
      expect(config1).toEqual(config2);
      expect(config1).not.toBe(config2); // different object references

      // Mutating one should not affect the other
      config1.rpcUrl = 'http://mutated:9999';
      const config3 = resolveChainConfig('anvil');
      expect(config3.rpcUrl).toBe('http://localhost:8545'); // original preset unaffected
    });
  });

  // --------------------------------------------------------------------------
  // 3.9-UNIT-001 [P2]: viem-only enforcement
  // Risk: E3-R009
  // --------------------------------------------------------------------------
  describe('viem-only enforcement (3.9-UNIT-001)', () => {
    it('[P2] no ethers imports in Epic 3 code (packages/{core,sdk,town}/src)', () => {
      // Static analysis: scan for ethers imports in Epic 3 source code
      // Exclude: test files, node_modules, connector package (architectural debt)
      const testExclude = /\.(test|spec)\.ts$/;
      const directories = [
        join(__dirname, '..', '..', '..', 'core', 'src'),
        join(__dirname, '..', '..', '..', 'sdk', 'src'),
        join(__dirname, '..', '..', '..', 'town', 'src'),
      ];

      // Match both bare 'ethers' and subpath imports like 'ethers/lib/utils'
      const ethersPattern = /from\s+['"]ethers(?:\/[^'"]*)?['"]/;
      const violations: string[] = [];

      for (const dir of directories) {
        const files = collectSourceFiles(dir, testExclude);
        for (const file of files) {
          const content = readFileSync(file, 'utf-8');
          if (ethersPattern.test(content)) {
            violations.push(file);
          }
        }
      }

      // Epic 3 code must be viem-only (Decision 7)
      expect(violations).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // 3.2-INT-001 [P0]: EIP-712 chain-awareness
  // Risk: E3-R004, E3-R005
  // --------------------------------------------------------------------------
  describe('EIP-712 chain-awareness (3.2-INT-001)', () => {
    it('[P0] EIP-712 domain separator uses resolved chainId, not hardcoded', () => {
      const anvilConfig = resolveChainConfig('anvil');
      const arbitrumConfig = resolveChainConfig('arbitrum-one');

      // Build EIP-712 domain separators for both chains
      const anvilDomain = buildEip712Domain(anvilConfig);
      const arbitrumDomain = buildEip712Domain(arbitrumConfig);

      expect(anvilDomain.chainId).toBe(ANVIL_CHAIN_ID);
      expect(anvilDomain.name).toBe('TokenNetwork');
      expect(anvilDomain.version).toBe('1');
      expect(anvilDomain.verifyingContract).toBe(ANVIL_TOKEN_NETWORK);
      expect(arbitrumDomain.chainId).toBe(ARBITRUM_ONE_CHAIN_ID);
      expect(anvilDomain.chainId).not.toBe(arbitrumDomain.chainId);
    });

    it('[P0] domain separators from different chains produce different structures', () => {
      // Cross-chain rejection: a signature produced with Anvil's domain
      // separator would fail verification against Arbitrum One's domain.
      // This test verifies the domain separators are indeed different.
      const anvilConfig = resolveChainConfig('anvil');
      const arbitrumConfig = resolveChainConfig('arbitrum-one');

      const anvilDomain = buildEip712Domain(anvilConfig);
      const arbitrumDomain = buildEip712Domain(arbitrumConfig);

      // Different chainId means the typed data hash will differ,
      // causing any cross-chain signature to fail verification.
      expect(anvilDomain.chainId).not.toBe(arbitrumDomain.chainId);
      // NOTE: verifyingContract comparison is currently trivially true
      // (anvil has a real address, arbitrum-one is '' because TokenNetwork
      // is not yet deployed). When TokenNetwork is deployed on Arbitrum One,
      // both will be non-empty but different. The chainId difference alone
      // is sufficient to prevent cross-chain signature acceptance.
      expect(anvilDomain.verifyingContract).not.toBe(
        arbitrumDomain.verifyingContract
      );
    });
  });

  // --------------------------------------------------------------------------
  // Additional: CHAIN_PRESETS map completeness
  // --------------------------------------------------------------------------
  describe('CHAIN_PRESETS completeness', () => {
    it('contains exactly 3 presets: anvil, arbitrum-sepolia, arbitrum-one', () => {
      expect(Object.keys(CHAIN_PRESETS)).toHaveLength(3);
      expect(CHAIN_PRESETS).toHaveProperty('anvil');
      expect(CHAIN_PRESETS).toHaveProperty('arbitrum-sepolia');
      expect(CHAIN_PRESETS).toHaveProperty('arbitrum-one');
    });

    it('anvil preset uses MOCK_USDC_ADDRESS from usdc.ts (no hardcoded duplication)', () => {
      // Verify the anvil preset's usdcAddress is the same constant imported
      // from usdc.ts, ensuring a single source of truth for the address.
      expect(CHAIN_PRESETS['anvil'].usdcAddress).toBe(MOCK_USDC_ADDRESS);
    });
  });

  // --------------------------------------------------------------------------
  // AC #4 coverage: CROSSTOWN_CHAIN env var with CROSSTOWN_RPC_URL combined
  // --------------------------------------------------------------------------
  describe('Combined environment variable overrides', () => {
    it('[P1] CROSSTOWN_CHAIN + CROSSTOWN_RPC_URL applies both overrides simultaneously', () => {
      vi.stubEnv('CROSSTOWN_CHAIN', 'arbitrum-sepolia');
      vi.stubEnv('CROSSTOWN_RPC_URL', 'https://my-private-rpc.example.com');

      const config = resolveChainConfig('anvil'); // param says anvil

      // CROSSTOWN_CHAIN wins over parameter
      expect(config.chainId).toBe(ARBITRUM_SEPOLIA_CHAIN_ID);
      expect(config.name).toBe('arbitrum-sepolia');
      // CROSSTOWN_RPC_URL overrides preset RPC
      expect(config.rpcUrl).toBe('https://my-private-rpc.example.com');
      // usdcAddress comes from the Sepolia preset, unaffected
      expect(config.usdcAddress).toBe(ARBITRUM_SEPOLIA_USDC);
    });

    it('[P1] CROSSTOWN_CHAIN + CROSSTOWN_TOKEN_NETWORK applies both overrides simultaneously', () => {
      vi.stubEnv('CROSSTOWN_CHAIN', 'arbitrum-one');
      const customTN = '0xDeadBeefDeadBeefDeadBeefDeadBeefDeadBeef';
      vi.stubEnv('CROSSTOWN_TOKEN_NETWORK', customTN);

      const config = resolveChainConfig(); // no param, defaults to anvil but env overrides

      expect(config.chainId).toBe(ARBITRUM_ONE_CHAIN_ID);
      expect(config.tokenNetworkAddress).toBe(customTN);
      expect(config.usdcAddress).toBe(ARBITRUM_ONE_USDC); // unaffected
    });

    it('[P1] all three env var overrides apply together', () => {
      vi.stubEnv('CROSSTOWN_CHAIN', 'arbitrum-one');
      vi.stubEnv('CROSSTOWN_RPC_URL', 'https://custom.rpc');
      vi.stubEnv('CROSSTOWN_TOKEN_NETWORK', '0x' + 'ff'.repeat(20));

      const config = resolveChainConfig('anvil');

      expect(config.chainId).toBe(ARBITRUM_ONE_CHAIN_ID);
      expect(config.rpcUrl).toBe('https://custom.rpc');
      expect(config.tokenNetworkAddress).toBe('0x' + 'ff'.repeat(20));
      expect(config.usdcAddress).toBe(ARBITRUM_ONE_USDC);
      expect(config.name).toBe('arbitrum-one');
    });
  });
});

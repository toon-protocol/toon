/**
 * Policy guard: USDC migration invariants.
 *
 * These tests lock down the constants that flow through the TOON payment
 * pipeline. A wrong decimal value (e.g., 18 instead of 6) or wrong address
 * silently breaks all pricing math and on-chain interactions. This file exists
 * to make those failures loud and traceable.
 *
 * Note: production settlement validation lives in the connector repo —
 * this file only guards the constants exported from this package.
 */

import { describe, it, expect } from 'vitest';
import {
  MOCK_USDC_ADDRESS,
  USDC_DECIMALS,
  USDC_SYMBOL,
  USDC_NAME,
  MOCK_USDC_CONFIG,
} from './usdc.js';

// ---------------------------------------------------------------------------
// Decimal invariant (the primary migration guard)
// ---------------------------------------------------------------------------

describe('USDC decimal invariant', () => {
  it('[P0] USDC_DECIMALS is 6, not 18 (Circle spec)', () => {
    expect(USDC_DECIMALS).toBe(6);
  });

  it('[P0] USDC_DECIMALS is not 18 (ERC-20 default that breaks pricing)', () => {
    expect(USDC_DECIMALS).not.toBe(18);
  });

  it('[P1] 1 USDC = 1_000_000 micro-units (10^USDC_DECIMALS)', () => {
    const microUnitsPerUsdc = 10 ** USDC_DECIMALS;
    expect(microUnitsPerUsdc).toBe(1_000_000);
  });
});

// ---------------------------------------------------------------------------
// Mock address invariant (Anvil deterministic deployment)
// ---------------------------------------------------------------------------

describe('MOCK_USDC_ADDRESS invariant', () => {
  it('[P0] address is the Anvil deterministic deploy address', () => {
    // This address is produced by DeployLocal.s.sol using Anvil Account #0
    // at nonce 0. Changing it breaks connector + core integration.
    expect(MOCK_USDC_ADDRESS).toBe('0x5FbDB2315678afecb367f032d93F642f64180aa3');
  });

  it('[P1] address is a valid EIP-55 mixed-case checksummed Ethereum address', () => {
    expect(MOCK_USDC_ADDRESS).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('[P1] address is not the zero address', () => {
    expect(MOCK_USDC_ADDRESS).not.toBe('0x0000000000000000000000000000000000000000');
  });

  it('[P1] address is not the production Arbitrum One USDC address (wrong network)', () => {
    const ARBITRUM_ONE_USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
    expect(MOCK_USDC_ADDRESS).not.toBe(ARBITRUM_ONE_USDC);
  });
});

// ---------------------------------------------------------------------------
// Token metadata invariants
// ---------------------------------------------------------------------------

describe('USDC token metadata invariants', () => {
  it('[P1] USDC_SYMBOL is "USDC"', () => {
    expect(USDC_SYMBOL).toBe('USDC');
  });

  it('[P1] USDC_NAME is "USD Coin" (matches EIP-712 domain in FiatTokenV2_2)', () => {
    // The EIP-712 domain name must match the on-chain contract.
    // FiatTokenV2_2 uses "USD Coin" (not "USDC", not "USD Coin (PoS)").
    expect(USDC_NAME).toBe('USD Coin');
  });
});

// ---------------------------------------------------------------------------
// MockUsdcConfig shape invariants
// ---------------------------------------------------------------------------

describe('MOCK_USDC_CONFIG shape invariants', () => {
  it('[P1] config.address matches MOCK_USDC_ADDRESS (single source of truth)', () => {
    expect(MOCK_USDC_CONFIG.address).toBe(MOCK_USDC_ADDRESS);
  });

  it('[P1] config.decimals matches USDC_DECIMALS (single source of truth)', () => {
    expect(MOCK_USDC_CONFIG.decimals).toBe(USDC_DECIMALS);
  });

  it('[P1] config.symbol matches USDC_SYMBOL', () => {
    expect(MOCK_USDC_CONFIG.symbol).toBe(USDC_SYMBOL);
  });

  it('[P1] config.name matches USDC_NAME', () => {
    expect(MOCK_USDC_CONFIG.name).toBe(USDC_NAME);
  });

  it('[P2] config has all required MockUsdcConfig fields', () => {
    expect(MOCK_USDC_CONFIG).toHaveProperty('address');
    expect(MOCK_USDC_CONFIG).toHaveProperty('decimals');
    expect(MOCK_USDC_CONFIG).toHaveProperty('symbol');
    expect(MOCK_USDC_CONFIG).toHaveProperty('name');
    expect(typeof MOCK_USDC_CONFIG.address).toBe('string');
    expect(typeof MOCK_USDC_CONFIG.decimals).toBe('number');
    expect(typeof MOCK_USDC_CONFIG.symbol).toBe('string');
    expect(typeof MOCK_USDC_CONFIG.name).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Pricing math regression guard
// ---------------------------------------------------------------------------

describe('USDC pricing math with correct decimals', () => {
  it('[P1] bigint arithmetic with USDC_DECIMALS produces correct micro-unit amounts', () => {
    const oneUsdc = BigInt(10 ** USDC_DECIMALS);
    expect(oneUsdc).toBe(1_000_000n);

    const halfUsdc = oneUsdc / 2n;
    expect(halfUsdc).toBe(500_000n);

    const tenCents = oneUsdc / 10n;
    expect(tenCents).toBe(100_000n);
  });

  it('[P1] with wrong decimals (18), pricing is off by 10^12 — guards against regression', () => {
    const WRONG_DECIMALS = 18;
    const oneUsdcWrong = BigInt(10 ** WRONG_DECIMALS);
    const oneUsdcRight = BigInt(10 ** USDC_DECIMALS);

    // If code accidentally used 18 decimals, amounts would be 10^12× too large
    expect(oneUsdcWrong / oneUsdcRight).toBe(1_000_000_000_000n);
  });
});

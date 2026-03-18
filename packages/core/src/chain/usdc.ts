/**
 * Mock USDC token configuration for local development (Anvil).
 *
 * In production, USDC is the native Circle USD Coin on Arbitrum One:
 *   0xaf88d065e77c8cC2239327C5EDb3A432268e5831
 *
 * For local development on Anvil, a mock ERC-20 is deployed at a
 * deterministic address by the DeployLocal.s.sol script in the connector
 * repo. This contract serves as the mock USDC for payment channel testing.
 *
 * **On-chain decimal discrepancy (Anvil only):**
 * The legacy on-chain mock contract on Anvil uses 18 decimals (inherited
 * from the original ERC-20 deploy script in the connector repo). The
 * constants below reflect production USDC semantics (6 decimals). When
 * interacting with the Anvil mock contract directly (e.g., fund-peer-wallet.sh,
 * faucet), use 18 decimals for on-chain amounts. The pricing pipeline
 * (basePricePerByte * toonLength) is denomination-agnostic (bigint math)
 * and works correctly regardless of on-chain decimals.
 *
 * **FiatTokenV2_2-compatible mock (Epic 5 prep):**
 * For DVM compute settlement and x402 testing with proper 6-decimal
 * semantics and EIP-3009 `transferWithAuthorization` support, deploy
 * the FiatTokenV2_2-compatible mock:
 *   `./scripts/deploy-mock-usdc.sh`
 * This deploys a contract with 6 decimals, EIP-3009, and EIP-712
 * domain matching production USDC ("USD Coin", version "2").
 *
 * USDC uses 6 decimals (not 18 like most ERC-20 tokens):
 *   1 USDC = 1,000,000 micro-USDC (10^6)
 *
 * @module
 */

/**
 * Mock USDC contract address on Anvil (deterministic from deployment).
 *
 * This is the first contract deployed by DeployLocal.s.sol using
 * Anvil Account #0 at nonce 0, giving it a deterministic address.
 */
export const MOCK_USDC_ADDRESS =
  '0x5FbDB2315678afecb367f032d93F642f64180aa3' as const;

/**
 * USDC uses 6 decimals (1 USDC = 1,000,000 micro-units).
 *
 * This differs from most ERC-20 tokens which use 18 decimals.
 * All pricing amounts in the TOON protocol are denominated
 * in USDC micro-units when using USDC as the settlement token.
 */
export const USDC_DECIMALS = 6 as const;

/** USDC token symbol. */
export const USDC_SYMBOL = 'USDC' as const;

/** USDC token name. */
export const USDC_NAME = 'USD Coin' as const;

/**
 * Configuration for the mock USDC contract deployment.
 */
export interface MockUsdcConfig {
  /** Contract address on the target chain */
  address: string;
  /** Number of decimal places (6 for USDC) */
  decimals: number;
  /** Token symbol */
  symbol: string;
  /** Token name */
  name: string;
}

/**
 * Default mock USDC configuration for Anvil local development.
 */
export const MOCK_USDC_CONFIG: MockUsdcConfig = {
  address: MOCK_USDC_ADDRESS,
  decimals: USDC_DECIMALS,
  symbol: USDC_SYMBOL,
  name: USDC_NAME,
};

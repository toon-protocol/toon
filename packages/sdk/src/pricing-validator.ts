/**
 * Pricing validator for @toon-protocol/sdk.
 *
 * Validates that incoming ILP payments meet the required price based on
 * TOON payload size and configured price per byte.
 */

import type { ToonRoutingMeta } from '@toon-protocol/core/toon';

export interface PricingValidatorConfig {
  basePricePerByte?: bigint;
  ownPubkey: string;
  kindPricing?: Record<number, bigint>;
}

export interface PricingValidationResult {
  accepted: boolean;
  rejection?: {
    accept: false;
    code: string;
    message: string;
    metadata?: Record<string, string>;
  };
}

/**
 * Creates a pricing validator that checks payment amounts against TOON size.
 */
export function createPricingValidator(config: PricingValidatorConfig) {
  const basePricePerByte = config.basePricePerByte ?? 10n;

  return {
    validate(meta: ToonRoutingMeta, amount: bigint): PricingValidationResult {
      // Self-write bypass
      if (meta.pubkey === config.ownPubkey) {
        return { accepted: true };
      }

      // Kind-specific pricing override (use Object.hasOwn for prototype-safe lookup)
      const kindOverride =
        config.kindPricing && Object.hasOwn(config.kindPricing, meta.kind)
          ? config.kindPricing[meta.kind]
          : undefined;
      const pricePerByte = kindOverride ?? basePricePerByte;

      const requiredAmount = BigInt(meta.rawBytes.length) * pricePerByte;

      if (amount < requiredAmount) {
        return {
          accepted: false,
          rejection: {
            accept: false,
            code: 'F04',
            message: 'Insufficient payment',
            metadata: {
              required: requiredAmount.toString(),
              received: amount.toString(),
            },
          },
        };
      }

      return { accepted: true };
    },
  };
}

/**
 * Verification pipeline for @toon-protocol/sdk.
 *
 * Verifies Schnorr signatures on incoming TOON payloads before dispatching
 * to handlers. In dev mode, verification is skipped.
 */

import type { ToonRoutingMeta } from '@toon-protocol/core/toon';
import { schnorr } from '@noble/curves/secp256k1.js';
import { hexToBytes } from '@noble/hashes/utils.js';

export interface VerificationResult {
  verified: boolean;
  rejection?: {
    accept: false;
    code: string;
    message: string;
  };
}

export interface VerificationPipelineConfig {
  devMode: boolean;
}

/**
 * Creates a verification pipeline that checks Schnorr signatures.
 */
export function createVerificationPipeline(config: VerificationPipelineConfig) {
  return {
    async verify(
      meta: ToonRoutingMeta,
      _toonData: string
    ): Promise<VerificationResult> {
      if (config.devMode) {
        return { verified: true };
      }

      try {
        const sigBytes = hexToBytes(meta.sig);
        const msgBytes = hexToBytes(meta.id);
        const pubkeyBytes = hexToBytes(meta.pubkey);
        const valid = schnorr.verify(sigBytes, msgBytes, pubkeyBytes);
        if (!valid) {
          return {
            verified: false,
            rejection: {
              accept: false,
              code: 'F06',
              message: 'Invalid Schnorr signature',
            },
          };
        }
        return { verified: true };
      } catch {
        return {
          verified: false,
          rejection: {
            accept: false,
            code: 'F06',
            message: 'Signature verification failed',
          },
        };
      }
    },
  };
}

/**
 * Customer-side attestation result verifier for TEE-attested DVM results.
 *
 * Verifies that a Kind 6xxx DVM result was computed in a valid TEE enclave
 * by checking the referenced kind:10033 attestation event. Three checks:
 * 1. Pubkey match: kind:10033 author === Kind 6xxx author (same provider)
 * 2. PCR validity: PCR values pass AttestationVerifier.verify()
 * 3. Time validity: attestation was VALID at result creation time
 *
 * This is a pure logic class with no transport concerns. The caller is
 * responsible for fetching the attestation event from the relay.
 */

import type { NostrEvent } from 'nostr-tools/pure';
import type { ParsedAttestation } from './attestation.js';
import type { ParsedJobResult } from './dvm.js';
import type { AttestationVerifier } from '../bootstrap/AttestationVerifier.js';
import { AttestationState } from '../bootstrap/AttestationVerifier.js';

// ---------- Types ----------

/** Configuration for constructing an AttestedResultVerifier. */
export interface AttestedResultVerificationOptions {
  /** The AttestationVerifier instance for PCR and state checks. */
  attestationVerifier: AttestationVerifier;
}

/** Result of verifying an attested DVM result. */
export interface AttestedResultVerificationResult {
  /** Whether the attestation verification passed all checks. */
  valid: boolean;
  /** Reason for failure (undefined when valid). */
  reason?: string;
  /** Attestation lifecycle state (undefined when verification fails before state check). */
  attestationState?: AttestationState;
}

// ---------- Class ----------

/**
 * Verifies TEE attestation on Kind 6xxx DVM result events.
 *
 * Follows the same pure-logic pattern as AttestationVerifier (Story 4.3).
 * Time injection is NOT at construction -- `resultEvent.created_at` is
 * used as the `now` parameter at call site.
 */
export class AttestedResultVerifier {
  private readonly attestationVerifier: AttestationVerifier;

  constructor(options: AttestedResultVerificationOptions) {
    this.attestationVerifier = options.attestationVerifier;
  }

  /**
   * Verifies that a Kind 6xxx result was computed in a valid TEE enclave.
   *
   * Performs three checks:
   * (a) Pubkey match: attestationEvent.pubkey === resultEvent.pubkey
   * (b) PCR validity: AttestationVerifier.verify(parsedAttestation.attestation)
   * (c) Time validity: attestation was VALID at resultEvent.created_at
   *
   * @param resultEvent - The Kind 6xxx result Nostr event.
   * @param _parsedResult - The parsed job result (reserved for future use).
   * @param attestationEvent - The kind:10033 attestation Nostr event.
   * @param parsedAttestation - The parsed attestation data.
   * @returns Verification result with valid flag, reason, and attestation state.
   */
  verifyAttestedResult(
    resultEvent: NostrEvent,
    _parsedResult: ParsedJobResult,
    attestationEvent: NostrEvent,
    parsedAttestation: ParsedAttestation
  ): AttestedResultVerificationResult {
    // Check (a): Pubkey match
    if (attestationEvent.pubkey !== resultEvent.pubkey) {
      return { valid: false, reason: 'pubkey mismatch' };
    }

    // Check (b): PCR validity
    const pcrResult = this.attestationVerifier.verify(
      parsedAttestation.attestation
    );
    if (!pcrResult.valid) {
      return { valid: false, reason: 'PCR mismatch' };
    }

    // Check (c): Time validity -- use resultEvent.created_at as `now`
    const state = this.attestationVerifier.getAttestationState(
      parsedAttestation.attestation,
      attestationEvent.created_at,
      resultEvent.created_at
    );
    if (state !== AttestationState.VALID) {
      return {
        valid: false,
        reason: 'attestation expired at result creation time',
        attestationState: state,
      };
    }

    return { valid: true, attestationState: AttestationState.VALID };
  }
}

// ---------- Utility Functions ----------

/**
 * Checks whether a parsed job request's params include `require_attestation=true`.
 *
 * @param params - The params array from a parsed job request.
 * @returns true if `require_attestation` is set to `'true'`.
 */
export function hasRequireAttestation(
  params: { key: string; value: string }[]
): boolean {
  return params.some(
    (p) => p.key === 'require_attestation' && p.value === 'true'
  );
}

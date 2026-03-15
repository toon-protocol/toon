/**
 * AttestationVerifier -- TEE attestation verification, state lifecycle,
 * and attestation-aware peer ranking for Story 4.3.
 *
 * This is a pure logic class with no transport layer. It receives parsed
 * attestation data and returns verification results. The transport layer
 * (subscribing to kind:10033 events on relays) is a Story 4.6 concern.
 *
 * The AttestationVerifier is the single source of truth for attestation
 * state (R-E4-008). Both the kind:10033 Nostr event path and the /health
 * HTTP endpoint derive their TEE state from the same verifier instance.
 *
 * Attestation State Machine (Decision 12):
 *   VALID (within validitySeconds)
 *     -> STALE (within graceSeconds after validity expires)
 *       -> UNATTESTED (after grace period expires)
 *
 * Trust degrades; money doesn't -- attestation state changes never
 * trigger payment channel closure.
 */

import type { TeeAttestation } from '../types.js';

// ---------- Enums ----------

/**
 * Attestation lifecycle state.
 *
 * Transitions: VALID -> STALE -> UNATTESTED.
 * A peer that was never attested starts as UNATTESTED.
 */
export enum AttestationState {
  /** Attestation is within validity period. */
  VALID = 'valid',
  /** Attestation has expired but is within the grace period. */
  STALE = 'stale',
  /** Attestation has expired past the grace period or was never attested. */
  UNATTESTED = 'unattested',
}

// ---------- Types ----------

/** Result of PCR verification against a known-good registry. */
export interface VerificationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Descriptor for a peer in the attestation-aware ranking system.
 * Used by `rankPeers()` to order peers by attestation status.
 */
export interface PeerDescriptor {
  pubkey: string;
  relayUrl: string;
  attested: boolean;
  attestationTimestamp?: number;
}

/**
 * Configuration for the AttestationVerifier.
 */
export interface AttestationVerifierConfig {
  /** Map of known-good PCR values. Key is PCR hash, value is trust status. */
  knownGoodPcrs: Map<string, boolean>;
  /** Attestation validity period in seconds (default: 300). */
  validitySeconds?: number;
  /** Grace period in seconds after validity expires before marking as unattested (default: 30). */
  graceSeconds?: number;
}

// ---------- Default Constants ----------

/** Default attestation validity period: 5 minutes. */
const DEFAULT_VALIDITY_SECONDS = 300;

/** Default grace period: 30 seconds. */
const DEFAULT_GRACE_SECONDS = 30;

// ---------- Class ----------

/**
 * Verifies TEE attestations, computes attestation lifecycle state,
 * and ranks peers by attestation status.
 *
 * Single source of truth for attestation state (R-E4-008).
 */
export class AttestationVerifier {
  private readonly knownGoodPcrs: Map<string, boolean>;
  private readonly validitySeconds: number;
  private readonly graceSeconds: number;

  constructor(config: AttestationVerifierConfig) {
    // Defensive copy: prevent external mutation from affecting verifier behavior
    this.knownGoodPcrs = new Map(config.knownGoodPcrs);

    const validity = config.validitySeconds ?? DEFAULT_VALIDITY_SECONDS;
    const grace = config.graceSeconds ?? DEFAULT_GRACE_SECONDS;

    if (!Number.isFinite(validity) || validity < 0) {
      throw new Error(
        `validitySeconds must be a non-negative finite number, got ${String(validity)}`
      );
    }
    if (!Number.isFinite(grace) || grace < 0) {
      throw new Error(
        `graceSeconds must be a non-negative finite number, got ${String(grace)}`
      );
    }

    this.validitySeconds = validity;
    this.graceSeconds = grace;
  }

  /**
   * Verifies a TEE attestation's PCR values against the known-good registry.
   *
   * All three PCR values (pcr0, pcr1, pcr2) must be present and truthy in
   * the registry for verification to pass.
   *
   * @param attestation - The TEE attestation to verify.
   * @returns Verification result with `valid: true` or `valid: false` with reason.
   */
  verify(attestation: TeeAttestation): VerificationResult {
    const pcr0Valid = this.knownGoodPcrs.get(attestation.pcr0) === true;
    const pcr1Valid = this.knownGoodPcrs.get(attestation.pcr1) === true;
    const pcr2Valid = this.knownGoodPcrs.get(attestation.pcr2) === true;

    if (pcr0Valid && pcr1Valid && pcr2Valid) {
      return { valid: true };
    }

    return { valid: false, reason: 'PCR mismatch' };
  }

  /**
   * Computes the attestation lifecycle state based on timing.
   *
   * Boundary behavior:
   * - At exactly `attestedAt + validitySeconds`: VALID (inclusive <=)
   * - At exactly `attestedAt + validitySeconds + graceSeconds`: STALE (inclusive <=)
   * - After grace expires: UNATTESTED
   *
   * @param _attestation - The TEE attestation (unused, reserved for future per-attestation logic).
   * @param attestedAt - Unix timestamp when the attestation was created.
   * @param now - Optional current unix timestamp (defaults to real clock).
   * @returns The current attestation state.
   */
  getAttestationState(
    _attestation: TeeAttestation,
    attestedAt: number,
    now?: number
  ): AttestationState {
    if (!Number.isFinite(attestedAt)) {
      return AttestationState.UNATTESTED;
    }
    const currentTime = now ?? Math.floor(Date.now() / 1000);
    const validityEnd = attestedAt + this.validitySeconds;
    const graceEnd = validityEnd + this.graceSeconds;

    if (currentTime <= validityEnd) {
      return AttestationState.VALID;
    }

    if (currentTime <= graceEnd) {
      return AttestationState.STALE;
    }

    return AttestationState.UNATTESTED;
  }

  /**
   * Ranks peers by attestation status: attested peers first, then non-attested.
   *
   * Preserves relative order within each group (stable sort via filter).
   * Does NOT mutate the input array -- returns a new sorted array.
   *
   * Attestation is a preference, not a requirement. Non-attested peers
   * remain in the result and are connectable.
   *
   * @param peers - Array of peer descriptors to rank.
   * @returns New array with attested peers first, preserving relative order.
   */
  rankPeers(peers: PeerDescriptor[]): PeerDescriptor[] {
    const attested = peers.filter((p) => p.attested);
    const nonAttested = peers.filter((p) => !p.attested);
    return [...attested, ...nonAttested];
  }
}

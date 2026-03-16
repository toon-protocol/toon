/**
 * AttestationBootstrap -- attestation-first seed relay bootstrap for Story 4.6.
 *
 * Implements FR-TEE-6: the bootstrap trust flow that verifies kind:10033 TEE
 * attestation on each seed relay BEFORE trusting its kind:10032 peer list.
 * This prevents seed relay list poisoning (R-E4-004).
 *
 * Trust flow:
 *   1. Read seed relay list from kind:10036 (Story 3.4)
 *   2. Connect to seed relay
 *   3. Query kind:10033 attestation
 *   4. Verify PCR measurement (Story 4.3)
 *   5. If valid -> subscribe to kind:10032 -> discover peers
 *   6. If invalid -> fall back to next seed relay
 *
 * This is a pure orchestration class with no transport logic. The
 * `queryAttestation` and `subscribePeers` callbacks are injected via DI,
 * keeping the class fully testable without WebSocket mocks.
 *
 * Decision 12 invariant: "Trust degrades; money doesn't." This class
 * never touches payment channel state.
 */

import type { NostrEvent } from 'nostr-tools/pure';
import type { VerificationResult } from './AttestationVerifier.js';

// ---------- Types ----------

/**
 * Configuration for the attestation-first bootstrap flow.
 */
export interface AttestationBootstrapConfig {
  /** Seed relay WebSocket URLs from kind:10036 */
  seedRelays: string[];
  /**
   * Nostr secret key for signing (reserved for future use).
   * @remarks Stored in config but not accessed by bootstrap(). Maintained for
   * API consistency with BootstrapService and future subscription signing.
   */
  secretKey: Uint8Array;
  /**
   * Verifier instance (or mock) with verify method.
   *
   * The DI interface accepts NostrEvent (the raw attestation event) and
   * returns boolean | Promise<boolean> | VerificationResult to support
   * both the real verifier (after caller extracts TeeAttestation) and
   * test mocks (which return Promise<boolean> via mockResolvedValue).
   *
   * The implementation normalizes via: await Promise.resolve(verifier.verify(event))
   */
  verifier: {
    verify: (
      attestation: NostrEvent
    ) => boolean | VerificationResult | Promise<boolean | VerificationResult>;
    getState?: (...args: unknown[]) => unknown;
  };
  /** DI callback: query a relay for its kind:10033 attestation event */
  queryAttestation: (relayUrl: string) => Promise<NostrEvent | null>;
  /** DI callback: subscribe to a relay's kind:10032 peer info events */
  subscribePeers: (relayUrl: string) => Promise<NostrEvent[]>;
}

/**
 * Result of the attestation-first bootstrap flow.
 */
export interface AttestationBootstrapResult {
  /** 'attested' if at least one seed relay passed verification, 'degraded' otherwise */
  mode: 'attested' | 'degraded';
  /** URL of the first seed relay that passed attestation (undefined in degraded mode) */
  attestedSeedRelay?: string;
  /** Peer info events discovered from attested seed relays */
  discoveredPeers: NostrEvent[];
}

/**
 * Lifecycle events emitted during attestation-first bootstrap.
 */
export type AttestationBootstrapEvent =
  | { type: 'attestation:seed-connected'; relayUrl: string }
  | { type: 'attestation:verified'; relayUrl: string; pubkey: string }
  | {
      type: 'attestation:verification-failed';
      relayUrl: string;
      reason: string;
    }
  | {
      type: 'attestation:peers-discovered';
      relayUrl: string;
      peerCount: number;
    }
  | { type: 'attestation:degraded'; triedCount: number };

/** Listener callback for attestation bootstrap events. */
export type AttestationBootstrapEventListener = (
  event: AttestationBootstrapEvent
) => void;

// ---------- Class ----------

/**
 * Orchestrates attestation-first seed relay bootstrap.
 *
 * Iterates seed relays sequentially, verifying kind:10033 attestation
 * before subscribing to kind:10032 peer info events. Falls back to
 * degraded mode when all seed relays fail attestation verification.
 */
export class AttestationBootstrap {
  private readonly config: AttestationBootstrapConfig;
  private listeners: AttestationBootstrapEventListener[] = [];

  constructor(config: AttestationBootstrapConfig) {
    this.config = config;
  }

  /**
   * Register an event listener.
   */
  on(listener: AttestationBootstrapEventListener): void {
    this.listeners.push(listener);
  }

  /**
   * Unregister an event listener.
   */
  off(listener: AttestationBootstrapEventListener): void {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }

  /**
   * Emit an attestation bootstrap event to all listeners.
   */
  private emit(event: AttestationBootstrapEvent): void {
    // Defensive copy: safe if a listener calls on()/off() during emission
    const snapshot = [...this.listeners];
    for (const listener of snapshot) {
      try {
        listener(event);
      } catch {
        // Don't let listener errors break bootstrap
      }
    }
  }

  /**
   * Execute the attestation-first bootstrap flow.
   *
   * Iterates seed relays in order:
   * 1. Emit seed-connected, query attestation
   * 2. If null or verify fails or error: emit verification-failed, try next
   * 3. If valid: emit verified, subscribe peers, emit peers-discovered
   * 4. Return attested result with discovered peers
   * 5. If ALL fail: log warning, emit degraded, return degraded result
   */
  async bootstrap(): Promise<AttestationBootstrapResult> {
    const { seedRelays, verifier, queryAttestation, subscribePeers } =
      this.config;

    for (const relayUrl of seedRelays) {
      this.emit({ type: 'attestation:seed-connected', relayUrl });

      try {
        const attestationEvent = await queryAttestation(relayUrl);

        if (attestationEvent === null) {
          this.emit({
            type: 'attestation:verification-failed',
            relayUrl,
            reason: 'No attestation event found',
          });
          continue;
        }

        // Normalize verify result: handles boolean, Promise<boolean>,
        // VerificationResult, and Promise<VerificationResult>
        const raw = await Promise.resolve(verifier.verify(attestationEvent));
        const isValid =
          typeof raw === 'boolean'
            ? raw
            : typeof raw === 'object' && raw !== null && 'valid' in raw
              ? (raw as VerificationResult).valid
              : false;

        if (!isValid) {
          this.emit({
            type: 'attestation:verification-failed',
            relayUrl,
            reason: 'Attestation verification failed',
          });
          continue;
        }

        // Attestation passed -- proceed to peer discovery
        this.emit({
          type: 'attestation:verified',
          relayUrl,
          pubkey: attestationEvent.pubkey,
        });

        const peers = await subscribePeers(relayUrl);

        this.emit({
          type: 'attestation:peers-discovered',
          relayUrl,
          peerCount: peers.length,
        });

        return {
          mode: 'attested',
          attestedSeedRelay: relayUrl,
          discoveredPeers: peers,
        };
      } catch (error: unknown) {
        // Callback errors (WebSocket failures, DNS, timeouts) treated as
        // failed attestation -- fall back to next relay.
        // NOTE: This catch covers both queryAttestation and subscribePeers
        // errors. When subscribePeers throws, the emitted event type is
        // 'attestation:verification-failed' even though attestation may have
        // passed. This is a known simplification -- adding a separate
        // 'attestation:peers-discovery-failed' event type is deferred.
        const reason = error instanceof Error ? error.message : 'Unknown error';
        this.emit({
          type: 'attestation:verification-failed',
          relayUrl,
          reason,
        });
      }
    }

    // All seed relays failed attestation -- degraded mode
    console.warn(
      `No attested seed relays found. Tried ${String(seedRelays.length)} relays. Starting in degraded mode.`
    );

    this.emit({
      type: 'attestation:degraded',
      triedCount: seedRelays.length,
    });

    return {
      mode: 'degraded',
      attestedSeedRelay: undefined,
      discoveredPeers: [],
    };
  }
}

/**
 * Nostr event kind constants for ILP-related events.
 *
 * These follow the NIP convention for replaceable (10000-19999) event kinds.
 */

/**
 * ILP Peer Info (kind 10032)
 * Replaceable event containing connector's ILP address, BTP endpoint, and settlement info.
 */
export const ILP_PEER_INFO_KIND = 10032;

/**
 * Service Discovery (kind 10035)
 * Replaceable event advertising a node's capabilities, pricing, and endpoints.
 * Published to the local relay and optionally to peers so that clients and
 * agents can programmatically discover available services.
 * NIP-16 replaceable: relays store only the latest event per pubkey + kind.
 */
export const SERVICE_DISCOVERY_KIND = 10035;

/**
 * Seed Relay List (kind 10036)
 * Replaceable event containing a list of relay nodes that serve as bootstrap
 * entry points for new network participants. Published to public Nostr relays.
 * NIP-16 replaceable: relays store only the latest event per pubkey + kind.
 */
export const SEED_RELAY_LIST_KIND = 10036;

/**
 * TEE Attestation (kind 10033)
 * NIP-16 replaceable event containing TEE attestation data: PCR values,
 * enclave image hash, and attestation documents from the TEE platform.
 * Published by nodes running in a Trusted Execution Environment (e.g.,
 * Marlin Oyster CVM / AWS Nitro Enclaves). Relays store only the latest
 * event per pubkey + kind. No `d` tag needed -- NIP-16 replaces by
 * pubkey + kind alone (unlike NIP-33 parameterized replaceable events).
 */
export const TEE_ATTESTATION_KIND = 10033;

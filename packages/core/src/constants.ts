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

// ---------------------------------------------------------------------------
// NIP-90 DVM (Data Vending Machine) Event Kinds
// ---------------------------------------------------------------------------

/**
 * Base kind for NIP-90 DVM job requests (kind range 5000-5999).
 * Job requests are regular (non-replaceable) events. Each specific DVM task
 * type is assigned a unique kind within this range (e.g., 5100 for text
 * generation). Providers listen for requests in their supported kind range.
 */
export const JOB_REQUEST_KIND_BASE = 5000;

/**
 * Base kind for NIP-90 DVM job results (kind range 6000-6999).
 * Result kind = request kind + 1000 (e.g., Kind 5100 request -> Kind 6100
 * result). Result events reference the original request via an `e` tag and
 * include the compute cost in an `amount` tag.
 */
export const JOB_RESULT_KIND_BASE = 6000;

/**
 * NIP-90 DVM job feedback (kind 7000).
 * A single kind used for all feedback messages (processing, error, success,
 * partial). Feedback events reference the original request via an `e` tag
 * and carry a `status` tag indicating the current job state.
 */
export const JOB_FEEDBACK_KIND = 7000;

/**
 * Text Generation DVM kind (kind 5100).
 * Reference DVM kind for the TOON protocol. Used for general-purpose
 * text generation tasks (e.g., LLM inference, summarization, Q&A).
 */
export const TEXT_GENERATION_KIND = 5100;

/**
 * Image Generation DVM kind (kind 5200).
 * Used for image generation tasks (e.g., text-to-image, image editing).
 * Optional provider support -- not all nodes are required to handle this kind.
 */
export const IMAGE_GENERATION_KIND = 5200;

/**
 * Text-to-Speech DVM kind (kind 5300).
 * Used for text-to-speech conversion tasks.
 * Optional provider support -- not all nodes are required to handle this kind.
 */
export const TEXT_TO_SPEECH_KIND = 5300;

/**
 * Translation DVM kind (kind 5302).
 * Used for language translation tasks.
 * Optional provider support -- not all nodes are required to handle this kind.
 */
export const TRANSLATION_KIND = 5302;

/**
 * Skill descriptor builder for DVM service discovery.
 *
 * Computes a SkillDescriptor from the handler registry and node configuration.
 * The descriptor is embedded in kind:10035 events to advertise DVM capabilities.
 *
 * Returns `undefined` when no DVM handlers are registered (backward compatible
 * with pre-DVM kind:10035 events).
 */

import { ToonError } from '@toon-protocol/core';
import type { SkillDescriptor, ReputationScore } from '@toon-protocol/core';
import type { HandlerRegistry } from './handler-registry.js';

/** Regex for 64-char lowercase hex string. */
const HEX_64_REGEX = /^[0-9a-f]{64}$/;

/** Configuration for building a skill descriptor. */
export interface BuildSkillDescriptorConfig {
  /** Base price per byte in USDC micro-units (default: 10n). */
  basePricePerByte?: bigint;
  /** Per-kind pricing overrides (kind number -> price in USDC micro-units). */
  kindPricing?: Record<number, bigint>;
  /** Service name override (default: 'toon-dvm'). */
  name?: string;
  /** Schema version override (default: '1.0'). */
  version?: string;
  /** Feature list override. */
  features?: string[];
  /** JSON Schema draft-07 object for job request parameters. */
  inputSchema?: Record<string, unknown>;
  /** Available AI models. */
  models?: string[];
  /** Pre-computed reputation score for the skill descriptor. */
  reputation?: ReputationScore;
  /** TEE attestation metadata for the skill descriptor. */
  attestation?: {
    /** 64-char hex event ID of the provider's latest kind:10033 attestation event. */
    eventId: string;
    /** Enclave image hash for the TEE environment. */
    enclaveImageHash: string;
  };
}

/**
 * Builds a SkillDescriptor from the handler registry and configuration.
 *
 * Returns `undefined` when the registry has no DVM handlers (kinds 5000-5999).
 * When DVM kinds exist, auto-populates the descriptor:
 * - `kinds` from `registry.getDvmKinds()`
 * - `pricing` from `config.kindPricing` overrides or `config.basePricePerByte` fallback
 * - `name`, `version`, `features`, `inputSchema`, `models` from config or defaults
 *
 * @param registry - The handler registry to read DVM kinds from.
 * @param config - Node configuration for pricing and optional overrides.
 * @returns A SkillDescriptor, or undefined if no DVM handlers are registered.
 */
export function buildSkillDescriptor(
  registry: HandlerRegistry,
  config: BuildSkillDescriptorConfig = {}
): SkillDescriptor | undefined {
  const dvmKinds = registry.getDvmKinds();
  if (dvmKinds.length === 0) {
    return undefined;
  }

  // Validate attestation eventId if provided
  if (config.attestation !== undefined) {
    if (!HEX_64_REGEX.test(config.attestation.eventId)) {
      throw new ToonError(
        'Skill descriptor attestation eventId must be a 64-character lowercase hex string',
        'DVM_SKILL_INVALID_ATTESTATION_EVENT_ID'
      );
    }
  }

  const basePricePerByte = config.basePricePerByte ?? 10n;
  const kindPricing = config.kindPricing ?? {};

  // Derive pricing: per-kind overrides or basePricePerByte fallback
  const pricing: Record<string, string> = {};
  for (const kind of dvmKinds) {
    if (Object.hasOwn(kindPricing, kind)) {
      pricing[String(kind)] = String(kindPricing[kind]);
    } else {
      pricing[String(kind)] = String(basePricePerByte);
    }
  }

  const descriptor: SkillDescriptor = {
    name: config.name ?? 'toon-dvm',
    version: config.version ?? '1.0',
    kinds: dvmKinds,
    features: config.features ?? [],
    inputSchema: config.inputSchema ?? { type: 'object', properties: {} },
    pricing,
  };

  if (config.models !== undefined) {
    descriptor.models = config.models;
  }

  if (config.reputation !== undefined) {
    descriptor.reputation = config.reputation;
  }

  if (config.attestation !== undefined) {
    descriptor.attestation = {
      eventId: config.attestation.eventId,
      enclaveImageHash: config.attestation.enclaveImageHash,
    };
  }

  return descriptor;
}

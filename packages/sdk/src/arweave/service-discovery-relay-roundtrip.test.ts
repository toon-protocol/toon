/**
 * ATDD tests for Story 8.0: Service Discovery Relay Query Path (AC #4)
 *
 * Test ID: 8.0-UNIT-018
 *
 * AC covered:
 * - AC #4: Provider service discovery — SkillDescriptor with kinds: [5094]
 *          is properly structured for relay publishing as kind:10035 and
 *          survives a build -> parse round-trip through the service discovery
 *          event builder/parser.
 *
 * The existing 8.0-UNIT-012 verifies buildSkillDescriptor() output structure.
 * This test verifies the descriptor can be embedded in a kind:10035 event
 * (buildServiceDiscoveryEvent) and recovered via parseServiceDiscovery(),
 * completing the relay publish/query path.
 */

import { describe, it, expect } from 'vitest';

import {
  buildServiceDiscoveryEvent,
  parseServiceDiscovery,
  SERVICE_DISCOVERY_KIND,
} from '@toon-protocol/core';
import type { ServiceDiscoveryContent } from '@toon-protocol/core';
import { buildSkillDescriptor } from '../skill-descriptor.js';
import { HandlerRegistry } from '../handler-registry.js';

// ============================================================================
// Test Helpers
// ============================================================================

// Deterministic secret key for test event signing
const TEST_SECRET_KEY = new Uint8Array(32).fill(42);

// ============================================================================
// 8.0-UNIT-018: Service Discovery Relay Round-Trip for kind:5094 (AC #4)
// ============================================================================

describe('Service Discovery Relay Query Path for kind:5094 (Story 8.0, AC #4)', () => {
  it('[P0] SkillDescriptor with kinds:[5094] survives kind:10035 build -> parse round-trip', () => {
    // Arrange: build a skill descriptor with kind:5094 from handler registry
    const registry = new HandlerRegistry();
    registry.on(5094, async () => ({ accept: true }));

    const descriptor = buildSkillDescriptor(registry, {
      kindPricing: { 5094: 100n },
      basePricePerByte: 10n,
      name: 'arweave-storage',
      version: '1.0',
      features: ['blob-storage', 'chunked-upload'],
    });

    expect(descriptor).toBeDefined();
    expect(descriptor!.kinds).toContain(5094);

    // Build a kind:10035 service discovery event embedding this descriptor
    const content: ServiceDiscoveryContent = {
      serviceType: 'rig',
      ilpAddress: 'g.toon.arweave-provider',
      pricing: { basePricePerByte: 10, currency: 'USDC' },
      supportedKinds: [1, 5094],
      capabilities: ['relay', 'dvm', 'arweave-storage'],
      chain: 'anvil',
      version: '1.0.0',
      skill: descriptor,
    };

    const event = buildServiceDiscoveryEvent(content, TEST_SECRET_KEY);

    // Assert: event is kind:10035
    expect(event.kind).toBe(SERVICE_DISCOVERY_KIND);

    // Parse the event back
    const parsed = parseServiceDiscovery(event);
    expect(parsed).not.toBeNull();

    // Verify the skill descriptor survived the round-trip
    expect(parsed!.skill).toBeDefined();
    expect(parsed!.skill!.kinds).toEqual([5094]);
    expect(parsed!.skill!.pricing).toEqual({ '5094': '100' });
    expect(parsed!.skill!.name).toBe('arweave-storage');
    expect(parsed!.skill!.version).toBe('1.0');
    expect(parsed!.skill!.features).toEqual(['blob-storage', 'chunked-upload']);
  });

  it('[P0] kind:10035 event with kind:5094 skill has correct d-tag for relay filtering', () => {
    // Arrange
    const registry = new HandlerRegistry();
    registry.on(5094, async () => ({ accept: true }));
    const descriptor = buildSkillDescriptor(registry, {
      kindPricing: { 5094: 50n },
      basePricePerByte: 10n,
    });

    const content: ServiceDiscoveryContent = {
      serviceType: 'rig',
      ilpAddress: 'g.toon.arweave-provider',
      pricing: { basePricePerByte: 10, currency: 'USDC' },
      supportedKinds: [5094],
      capabilities: ['dvm'],
      chain: 'anvil',
      version: '1.0.0',
      skill: descriptor,
    };

    // Act
    const event = buildServiceDiscoveryEvent(content, TEST_SECRET_KEY);

    // Assert: d-tag is present for relay query filtering (NIP-16 replaceable)
    const dTag = event.tags.find(
      (t: string[]) => t[0] === 'd' && t[1] === 'toon-service-discovery'
    );
    expect(dTag).toBeDefined();
    // Agents can query relays with filter: { kinds: [10035], '#d': ['toon-service-discovery'] }
  });

  it('[P1] multiple DVM kinds including 5094 all preserved in round-trip', () => {
    // Arrange: provider supports both text generation (5100) and blob storage (5094)
    const registry = new HandlerRegistry();
    registry.on(5094, async () => ({ accept: true }));
    registry.on(5100, async () => ({ accept: true }));

    const descriptor = buildSkillDescriptor(registry, {
      kindPricing: { 5094: 100n, 5100: 50n },
      basePricePerByte: 10n,
    });

    const content: ServiceDiscoveryContent = {
      serviceType: 'rig',
      ilpAddress: 'g.toon.multi-skill-provider',
      pricing: { basePricePerByte: 10, currency: 'USDC' },
      supportedKinds: [1, 5094, 5100],
      capabilities: ['dvm', 'arweave-storage', 'text-generation'],
      chain: 'anvil',
      version: '1.0.0',
      skill: descriptor,
    };

    const event = buildServiceDiscoveryEvent(content, TEST_SECRET_KEY);
    const parsed = parseServiceDiscovery(event);

    expect(parsed).not.toBeNull();
    expect(parsed!.skill!.kinds).toContain(5094);
    expect(parsed!.skill!.kinds).toContain(5100);
    expect(parsed!.skill!.pricing['5094']).toBe('100');
    expect(parsed!.skill!.pricing['5100']).toBe('50');
  });
});

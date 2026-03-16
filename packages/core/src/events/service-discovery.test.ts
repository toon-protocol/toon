/**
 * ATDD tests for Story 3.5: kind:10035 Service Discovery Events (FR-PROD-5)
 *
 * TDD RED PHASE: Tests import from ./service-discovery.js which does not
 * exist yet. Tests will fail with module-not-found errors until the
 * implementation is created.
 *
 * Validates:
 * - kind:10035 event published on bootstrap (build + sign)
 * - Content correctness (service type, ILP address, pricing, x402 endpoint)
 * - x402 field entirely omitted when disabled (not set to { enabled: false })
 * - NIP-16 replaceable event pattern (d tag with 'crosstown-service-discovery')
 * - SERVICE_DISCOVERY_KIND constant equals 10035
 * - parseServiceDiscovery() graceful degradation for malformed content
 * - parseServiceDiscovery() validation of required fields
 * - buildServiceDiscoveryEvent() kind and created_at correctness
 * - buildServiceDiscoveryEvent() returns valid signed event (id/sig format)
 *
 * Gap-filling tests (AC coverage hardening):
 * - NIP-16 range validation (kind 10000-19999)
 * - Missing capabilities field validation
 * - Invalid pricing sub-field validation (basePricePerByte type, missing currency)
 * - x402 field validation (invalid enabled type, invalid endpoint type, optional endpoint)
 * - Edge cases: null content, empty string content, mixed-type arrays
 * - Content serialization round-trip (JSON fidelity)
 * - Tags structure (exactly one d tag)
 * - Schnorr signature verification via verifyEvent()
 * - Pricing as array (defensive -- arrays are objects in JS)
 * - Forward compatibility (extra unknown fields preserved without error)
 *
 * Test IDs from test-design-epic-3.md:
 * - 3.5-INT-001 [P1]: kind:10035 published on bootstrap
 * - 3.5-INT-002 [P1]: kind:10035 content correctness
 * - 3.5-INT-003 [P2]: kind:10035 omits x402 when disabled
 * - 3.5-UNIT-001 [P2]: kind:10035 replaceable (NIP-16)
 * - T-3.5-05 [P2]: SERVICE_DISCOVERY_KIND constant
 * - T-3.5-06 [P2]: parseServiceDiscovery malformed content
 * - T-3.5-07 [P2]: parseServiceDiscovery missing required fields
 * - T-3.5-08 [P2]: buildServiceDiscoveryEvent kind and created_at
 * - T-3.5-09 [P2]: buildServiceDiscoveryEvent valid signed event
 */

import { describe, it, expect } from 'vitest';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';

// These imports will cause module-not-found errors until implementation
// is created in service-discovery.ts (TDD RED PHASE).
import {
  buildServiceDiscoveryEvent,
  parseServiceDiscovery,
  SERVICE_DISCOVERY_KIND,
} from './service-discovery.js';
import type { ServiceDiscoveryContent } from './service-discovery.js';

// ============================================================================
// Factories
// ============================================================================

/**
 * Creates a valid service discovery content payload with x402 enabled.
 * Use overrides to customize specific fields for individual test scenarios.
 */
function createServiceDiscoveryContent(
  overrides: Partial<ServiceDiscoveryContent> = {}
): ServiceDiscoveryContent {
  return {
    serviceType: 'relay',
    ilpAddress: 'g.crosstown.test-relay',
    pricing: {
      basePricePerByte: 10,
      currency: 'USDC',
    },
    x402: {
      enabled: true,
      endpoint: '/publish',
    },
    supportedKinds: [1, 10032, 10036],
    capabilities: ['relay', 'x402'],
    chain: 'arbitrum-one',
    version: '0.1.0',
    ...overrides,
  };
}

/**
 * Creates a valid service discovery content payload with x402 disabled
 * (x402 field entirely omitted, per AC #3).
 */
function createIlpOnlyContent(): ServiceDiscoveryContent {
  return {
    serviceType: 'relay',
    ilpAddress: 'g.crosstown.test-relay',
    pricing: {
      basePricePerByte: 10,
      currency: 'USDC',
    },
    supportedKinds: [1, 10032, 10036],
    capabilities: ['relay'],
    chain: 'anvil',
    version: '0.1.0',
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('Story 3.5: kind:10035 Service Discovery Events', () => {
  // --------------------------------------------------------------------------
  // T-3.5-05 [P2]: SERVICE_DISCOVERY_KIND constant
  // --------------------------------------------------------------------------
  describe('SERVICE_DISCOVERY_KIND constant (T-3.5-05)', () => {
    it('[P2] SERVICE_DISCOVERY_KIND equals 10035', () => {
      // Assert: constant matches the NIP-16 replaceable kind range
      expect(SERVICE_DISCOVERY_KIND).toBe(10035);
    });
  });

  // --------------------------------------------------------------------------
  // 3.5-INT-001 [P1]: kind:10035 published on bootstrap
  // --------------------------------------------------------------------------
  describe('kind:10035 published on bootstrap (3.5-INT-001)', () => {
    it('[P1] node publishes kind:10035 event after bootstrap completes', () => {
      // Arrange
      const secretKey = generateSecretKey();
      const content = createServiceDiscoveryContent();

      // Act
      const event = buildServiceDiscoveryEvent(content, secretKey);

      // Assert: event is properly constructed and signed
      expect(event.kind).toBe(SERVICE_DISCOVERY_KIND);
      expect(event.pubkey).toBe(getPublicKey(secretKey));
      expect(event.id).toMatch(/^[0-9a-f]{64}$/);
      expect(event.sig).toMatch(/^[0-9a-f]{128}$/);
      expect(event.created_at).toBeGreaterThan(0);
    });
  });

  // --------------------------------------------------------------------------
  // 3.5-INT-002 [P1]: kind:10035 content correctness
  // --------------------------------------------------------------------------
  describe('kind:10035 content correctness (3.5-INT-002)', () => {
    it('[P1] event content contains service type, ILP address, pricing, x402 endpoint', () => {
      // Arrange
      const secretKey = generateSecretKey();
      const content = createServiceDiscoveryContent();

      // Act
      const event = buildServiceDiscoveryEvent(content, secretKey);
      const parsed = parseServiceDiscovery(event);

      // Assert: all fields round-trip correctly
      expect(parsed).not.toBeNull();
      expect(parsed!.serviceType).toBe('relay');
      expect(parsed!.ilpAddress).toBe('g.crosstown.test-relay');
      expect(parsed!.pricing.basePricePerByte).toBe(10);
      expect(parsed!.pricing.currency).toBe('USDC');
      expect(parsed!.x402).toBeDefined();
      expect(parsed!.x402!.enabled).toBe(true);
      expect(parsed!.x402!.endpoint).toBe('/publish');
      expect(parsed!.supportedKinds).toContain(1);
      expect(parsed!.supportedKinds).toContain(10032);
      expect(parsed!.supportedKinds).toContain(10036);
      expect(parsed!.capabilities).toContain('relay');
      expect(parsed!.capabilities).toContain('x402');
      expect(parsed!.chain).toBe('arbitrum-one');
      expect(parsed!.version).toBe('0.1.0');
    });
  });

  // --------------------------------------------------------------------------
  // 3.5-INT-003 [P2]: kind:10035 omits x402 when disabled
  // --------------------------------------------------------------------------
  describe('kind:10035 omits x402 when disabled (3.5-INT-003)', () => {
    it('[P2] x402 disabled -> event advertises ILP-only access (x402 field omitted)', () => {
      // Arrange: content built WITHOUT x402 field (AC #3: entirely omitted)
      const secretKey = generateSecretKey();
      const content = createIlpOnlyContent();

      // Act
      const event = buildServiceDiscoveryEvent(content, secretKey);
      const parsed = parseServiceDiscovery(event);

      // Assert: x402 field is entirely absent (not { enabled: false })
      expect(parsed).not.toBeNull();
      expect(parsed!.x402).toBeUndefined();
      expect(parsed!.capabilities).not.toContain('x402');
      expect(parsed!.capabilities).toContain('relay');
    });
  });

  // --------------------------------------------------------------------------
  // 3.5-UNIT-001 [P2]: kind:10035 replaceable (NIP-16)
  // Risk: E3-R011
  // --------------------------------------------------------------------------
  describe('kind:10035 NIP-16 replaceable pattern (3.5-UNIT-001)', () => {
    it('[P2] event has d tag for NIP-16 replaceable event pattern', () => {
      // Arrange
      const secretKey = generateSecretKey();
      const content = createServiceDiscoveryContent();

      // Act
      const event = buildServiceDiscoveryEvent(content, secretKey);

      // Assert: NIP-16 replaceable events use d tag as content marker
      const dTag = event.tags.find((t: string[]) => t[0] === 'd');
      expect(dTag).toBeDefined();
      expect(dTag![1]).toBe('crosstown-service-discovery');
    });
  });

  // --------------------------------------------------------------------------
  // T-3.5-06 [P2]: parseServiceDiscovery graceful degradation
  // --------------------------------------------------------------------------
  describe('parseServiceDiscovery() graceful degradation (T-3.5-06)', () => {
    it('[P2] returns null for malformed JSON content', () => {
      // Arrange: event with invalid JSON content
      const malformedEvent = {
        kind: 10035,
        content: 'not valid json {{{',
        tags: [['d', 'crosstown-service-discovery']],
        created_at: Math.floor(Date.now() / 1000),
        pubkey: 'a'.repeat(64),
        id: 'b'.repeat(64),
        sig: 'c'.repeat(128),
      };

      // Act
      const result = parseServiceDiscovery(malformedEvent);

      // Assert: graceful degradation returns null
      expect(result).toBeNull();
    });

    it('[P2] returns null for non-object JSON content', () => {
      // Arrange: event with JSON array instead of object
      const arrayEvent = {
        kind: 10035,
        content: '["not", "an", "object"]',
        tags: [['d', 'crosstown-service-discovery']],
        created_at: Math.floor(Date.now() / 1000),
        pubkey: 'a'.repeat(64),
        id: 'b'.repeat(64),
        sig: 'c'.repeat(128),
      };

      // Act
      const result = parseServiceDiscovery(arrayEvent);

      // Assert
      expect(result).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // T-3.5-07 [P2]: parseServiceDiscovery missing required fields
  // --------------------------------------------------------------------------
  describe('parseServiceDiscovery() missing required fields (T-3.5-07)', () => {
    it('[P2] returns null when serviceType is missing', () => {
      // Arrange: content missing serviceType
      const event = {
        kind: 10035,
        content: JSON.stringify({
          ilpAddress: 'g.crosstown.test',
          pricing: { basePricePerByte: 10, currency: 'USDC' },
          supportedKinds: [1],
          capabilities: ['relay'],
          chain: 'anvil',
          version: '0.1.0',
        }),
        tags: [['d', 'crosstown-service-discovery']],
        created_at: Math.floor(Date.now() / 1000),
        pubkey: 'a'.repeat(64),
        id: 'b'.repeat(64),
        sig: 'c'.repeat(128),
      };

      // Act
      const result = parseServiceDiscovery(event);

      // Assert
      expect(result).toBeNull();
    });

    it('[P2] returns null when pricing is missing', () => {
      // Arrange: content missing pricing
      const event = {
        kind: 10035,
        content: JSON.stringify({
          serviceType: 'relay',
          ilpAddress: 'g.crosstown.test',
          supportedKinds: [1],
          capabilities: ['relay'],
          chain: 'anvil',
          version: '0.1.0',
        }),
        tags: [['d', 'crosstown-service-discovery']],
        created_at: Math.floor(Date.now() / 1000),
        pubkey: 'a'.repeat(64),
        id: 'b'.repeat(64),
        sig: 'c'.repeat(128),
      };

      // Act
      const result = parseServiceDiscovery(event);

      // Assert
      expect(result).toBeNull();
    });

    it('[P2] returns null when ilpAddress is missing', () => {
      // Arrange: content missing ilpAddress
      const event = {
        kind: 10035,
        content: JSON.stringify({
          serviceType: 'relay',
          pricing: { basePricePerByte: 10, currency: 'USDC' },
          supportedKinds: [1],
          capabilities: ['relay'],
          chain: 'anvil',
          version: '0.1.0',
        }),
        tags: [['d', 'crosstown-service-discovery']],
        created_at: Math.floor(Date.now() / 1000),
        pubkey: 'a'.repeat(64),
        id: 'b'.repeat(64),
        sig: 'c'.repeat(128),
      };

      // Act
      const result = parseServiceDiscovery(event);

      // Assert
      expect(result).toBeNull();
    });

    it('[P2] returns null when supportedKinds is not an array', () => {
      // Arrange: content with non-array supportedKinds
      const event = {
        kind: 10035,
        content: JSON.stringify({
          serviceType: 'relay',
          ilpAddress: 'g.crosstown.test',
          pricing: { basePricePerByte: 10, currency: 'USDC' },
          supportedKinds: 'not-an-array',
          capabilities: ['relay'],
          chain: 'anvil',
          version: '0.1.0',
        }),
        tags: [['d', 'crosstown-service-discovery']],
        created_at: Math.floor(Date.now() / 1000),
        pubkey: 'a'.repeat(64),
        id: 'b'.repeat(64),
        sig: 'c'.repeat(128),
      };

      // Act
      const result = parseServiceDiscovery(event);

      // Assert
      expect(result).toBeNull();
    });

    it('[P2] returns null when chain is missing', () => {
      // Arrange: content missing chain
      const event = {
        kind: 10035,
        content: JSON.stringify({
          serviceType: 'relay',
          ilpAddress: 'g.crosstown.test',
          pricing: { basePricePerByte: 10, currency: 'USDC' },
          supportedKinds: [1],
          capabilities: ['relay'],
          version: '0.1.0',
        }),
        tags: [['d', 'crosstown-service-discovery']],
        created_at: Math.floor(Date.now() / 1000),
        pubkey: 'a'.repeat(64),
        id: 'b'.repeat(64),
        sig: 'c'.repeat(128),
      };

      // Act
      const result = parseServiceDiscovery(event);

      // Assert
      expect(result).toBeNull();
    });

    it('[P2] returns null when version is missing', () => {
      // Arrange: content missing version
      const event = {
        kind: 10035,
        content: JSON.stringify({
          serviceType: 'relay',
          ilpAddress: 'g.crosstown.test',
          pricing: { basePricePerByte: 10, currency: 'USDC' },
          supportedKinds: [1],
          capabilities: ['relay'],
          chain: 'anvil',
        }),
        tags: [['d', 'crosstown-service-discovery']],
        created_at: Math.floor(Date.now() / 1000),
        pubkey: 'a'.repeat(64),
        id: 'b'.repeat(64),
        sig: 'c'.repeat(128),
      };

      // Act
      const result = parseServiceDiscovery(event);

      // Assert
      expect(result).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // T-3.5-08 [P2]: buildServiceDiscoveryEvent kind and created_at
  // --------------------------------------------------------------------------
  describe('buildServiceDiscoveryEvent() kind and created_at (T-3.5-08)', () => {
    it('[P2] includes correct kind 10035 and valid created_at timestamp', () => {
      // Arrange
      const secretKey = generateSecretKey();
      const content = createServiceDiscoveryContent();
      const beforeTimestamp = Math.floor(Date.now() / 1000);

      // Act
      const event = buildServiceDiscoveryEvent(content, secretKey);

      // Assert: kind is SERVICE_DISCOVERY_KIND (10035)
      expect(event.kind).toBe(10035);
      // Assert: created_at is a recent Unix timestamp
      expect(event.created_at).toBeGreaterThanOrEqual(beforeTimestamp);
      expect(event.created_at).toBeLessThanOrEqual(
        Math.floor(Date.now() / 1000) + 1
      );
    });
  });

  // --------------------------------------------------------------------------
  // T-3.5-09 [P2]: buildServiceDiscoveryEvent valid signed event
  // --------------------------------------------------------------------------
  describe('buildServiceDiscoveryEvent() returns valid signed event (T-3.5-09)', () => {
    it('[P2] returns event with valid id (64 hex chars) and sig (128 hex chars)', () => {
      // Arrange
      const secretKey = generateSecretKey();
      const content = createServiceDiscoveryContent();

      // Act
      const event = buildServiceDiscoveryEvent(content, secretKey);

      // Assert: id is a 64-char lowercase hex string (SHA-256 of serialized event)
      expect(event.id).toMatch(/^[0-9a-f]{64}$/);
      // Assert: sig is a 128-char lowercase hex string (Schnorr signature)
      expect(event.sig).toMatch(/^[0-9a-f]{128}$/);
      // Assert: content is valid JSON
      expect(() => JSON.parse(event.content)).not.toThrow();
      // Assert: pubkey matches the secret key
      expect(event.pubkey).toBe(getPublicKey(secretKey));
    });
  });

  // ==========================================================================
  // Gap-filling tests: additional AC coverage
  // ==========================================================================

  // --------------------------------------------------------------------------
  // AC #4: SERVICE_DISCOVERY_KIND is in NIP-16 replaceable range (10000-19999)
  // --------------------------------------------------------------------------
  describe('SERVICE_DISCOVERY_KIND NIP-16 range validation (AC #4)', () => {
    it('kind 10035 is within the NIP-16 replaceable range (10000-19999)', () => {
      // Assert: kind is in NIP-16 replaceable range, not NIP-33 (30000-39999)
      expect(SERVICE_DISCOVERY_KIND).toBeGreaterThanOrEqual(10000);
      expect(SERVICE_DISCOVERY_KIND).toBeLessThanOrEqual(19999);
    });
  });

  // --------------------------------------------------------------------------
  // AC #2: parseServiceDiscovery() -- missing capabilities (required array)
  // --------------------------------------------------------------------------
  describe('parseServiceDiscovery() missing capabilities (AC #2)', () => {
    it('returns null when capabilities is missing', () => {
      // Arrange: content missing capabilities field
      const event = {
        kind: 10035,
        content: JSON.stringify({
          serviceType: 'relay',
          ilpAddress: 'g.crosstown.test',
          pricing: { basePricePerByte: 10, currency: 'USDC' },
          supportedKinds: [1],
          chain: 'anvil',
          version: '0.1.0',
        }),
        tags: [['d', 'crosstown-service-discovery']],
        created_at: Math.floor(Date.now() / 1000),
        pubkey: 'a'.repeat(64),
        id: 'b'.repeat(64),
        sig: 'c'.repeat(128),
      };

      // Act
      const result = parseServiceDiscovery(event);

      // Assert
      expect(result).toBeNull();
    });

    it('returns null when capabilities is not an array', () => {
      // Arrange: capabilities is a string instead of array
      const event = {
        kind: 10035,
        content: JSON.stringify({
          serviceType: 'relay',
          ilpAddress: 'g.crosstown.test',
          pricing: { basePricePerByte: 10, currency: 'USDC' },
          supportedKinds: [1],
          capabilities: 'relay',
          chain: 'anvil',
          version: '0.1.0',
        }),
        tags: [['d', 'crosstown-service-discovery']],
        created_at: Math.floor(Date.now() / 1000),
        pubkey: 'a'.repeat(64),
        id: 'b'.repeat(64),
        sig: 'c'.repeat(128),
      };

      // Act
      const result = parseServiceDiscovery(event);

      // Assert
      expect(result).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // AC #2: parseServiceDiscovery() -- invalid pricing sub-fields
  // --------------------------------------------------------------------------
  describe('parseServiceDiscovery() invalid pricing sub-fields (AC #2)', () => {
    it('returns null when pricing.basePricePerByte is a string', () => {
      // Arrange: basePricePerByte is a string, not a number
      const event = {
        kind: 10035,
        content: JSON.stringify({
          serviceType: 'relay',
          ilpAddress: 'g.crosstown.test',
          pricing: { basePricePerByte: '10', currency: 'USDC' },
          supportedKinds: [1],
          capabilities: ['relay'],
          chain: 'anvil',
          version: '0.1.0',
        }),
        tags: [['d', 'crosstown-service-discovery']],
        created_at: Math.floor(Date.now() / 1000),
        pubkey: 'a'.repeat(64),
        id: 'b'.repeat(64),
        sig: 'c'.repeat(128),
      };

      // Act
      const result = parseServiceDiscovery(event);

      // Assert
      expect(result).toBeNull();
    });

    it('returns null when pricing.currency is missing', () => {
      // Arrange: pricing object lacks currency field
      const event = {
        kind: 10035,
        content: JSON.stringify({
          serviceType: 'relay',
          ilpAddress: 'g.crosstown.test',
          pricing: { basePricePerByte: 10 },
          supportedKinds: [1],
          capabilities: ['relay'],
          chain: 'anvil',
          version: '0.1.0',
        }),
        tags: [['d', 'crosstown-service-discovery']],
        created_at: Math.floor(Date.now() / 1000),
        pubkey: 'a'.repeat(64),
        id: 'b'.repeat(64),
        sig: 'c'.repeat(128),
      };

      // Act
      const result = parseServiceDiscovery(event);

      // Assert
      expect(result).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // AC #2: parseServiceDiscovery() -- x402 with invalid enabled field
  // --------------------------------------------------------------------------
  describe('parseServiceDiscovery() x402 validation (AC #2, #3)', () => {
    it('returns null when x402.enabled is not a boolean', () => {
      // Arrange: x402.enabled is a string, not a boolean
      const event = {
        kind: 10035,
        content: JSON.stringify({
          serviceType: 'relay',
          ilpAddress: 'g.crosstown.test',
          pricing: { basePricePerByte: 10, currency: 'USDC' },
          supportedKinds: [1],
          capabilities: ['relay'],
          chain: 'anvil',
          version: '0.1.0',
          x402: { enabled: 'yes', endpoint: '/publish' },
        }),
        tags: [['d', 'crosstown-service-discovery']],
        created_at: Math.floor(Date.now() / 1000),
        pubkey: 'a'.repeat(64),
        id: 'b'.repeat(64),
        sig: 'c'.repeat(128),
      };

      // Act
      const result = parseServiceDiscovery(event);

      // Assert
      expect(result).toBeNull();
    });

    it('returns null when x402.endpoint is not a string', () => {
      // Arrange: x402.endpoint is a number, not a string
      const event = {
        kind: 10035,
        content: JSON.stringify({
          serviceType: 'relay',
          ilpAddress: 'g.crosstown.test',
          pricing: { basePricePerByte: 10, currency: 'USDC' },
          supportedKinds: [1],
          capabilities: ['relay'],
          chain: 'anvil',
          version: '0.1.0',
          x402: { enabled: true, endpoint: 42 },
        }),
        tags: [['d', 'crosstown-service-discovery']],
        created_at: Math.floor(Date.now() / 1000),
        pubkey: 'a'.repeat(64),
        id: 'b'.repeat(64),
        sig: 'c'.repeat(128),
      };

      // Act
      const result = parseServiceDiscovery(event);

      // Assert
      expect(result).toBeNull();
    });

    it('parses x402 without endpoint field (endpoint is optional)', () => {
      // Arrange: x402 has enabled:true but no endpoint field
      const event = {
        kind: 10035,
        content: JSON.stringify({
          serviceType: 'relay',
          ilpAddress: 'g.crosstown.test',
          pricing: { basePricePerByte: 10, currency: 'USDC' },
          supportedKinds: [1],
          capabilities: ['relay', 'x402'],
          chain: 'anvil',
          version: '0.1.0',
          x402: { enabled: true },
        }),
        tags: [['d', 'crosstown-service-discovery']],
        created_at: Math.floor(Date.now() / 1000),
        pubkey: 'a'.repeat(64),
        id: 'b'.repeat(64),
        sig: 'c'.repeat(128),
      };

      // Act
      const result = parseServiceDiscovery(event);

      // Assert: parses successfully with x402.enabled but no endpoint
      expect(result).not.toBeNull();
      expect(result!.x402).toBeDefined();
      expect(result!.x402!.enabled).toBe(true);
      expect(result!.x402!.endpoint).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // AC #2: parseServiceDiscovery() -- null JSON content string
  // --------------------------------------------------------------------------
  describe('parseServiceDiscovery() edge cases (AC #2)', () => {
    it('returns null for JSON null content', () => {
      // Arrange: event content is the string "null"
      const event = {
        kind: 10035,
        content: 'null',
        tags: [['d', 'crosstown-service-discovery']],
        created_at: Math.floor(Date.now() / 1000),
        pubkey: 'a'.repeat(64),
        id: 'b'.repeat(64),
        sig: 'c'.repeat(128),
      };

      // Act
      const result = parseServiceDiscovery(event);

      // Assert: null is not a valid object
      expect(result).toBeNull();
    });

    it('returns null for empty string content', () => {
      // Arrange: event content is an empty string (not valid JSON)
      const event = {
        kind: 10035,
        content: '',
        tags: [['d', 'crosstown-service-discovery']],
        created_at: Math.floor(Date.now() / 1000),
        pubkey: 'a'.repeat(64),
        id: 'b'.repeat(64),
        sig: 'c'.repeat(128),
      };

      // Act
      const result = parseServiceDiscovery(event);

      // Assert
      expect(result).toBeNull();
    });

    it('returns null when supportedKinds contains non-numbers', () => {
      // Arrange: supportedKinds has a string element
      const event = {
        kind: 10035,
        content: JSON.stringify({
          serviceType: 'relay',
          ilpAddress: 'g.crosstown.test',
          pricing: { basePricePerByte: 10, currency: 'USDC' },
          supportedKinds: [1, 'invalid', 10036],
          capabilities: ['relay'],
          chain: 'anvil',
          version: '0.1.0',
        }),
        tags: [['d', 'crosstown-service-discovery']],
        created_at: Math.floor(Date.now() / 1000),
        pubkey: 'a'.repeat(64),
        id: 'b'.repeat(64),
        sig: 'c'.repeat(128),
      };

      // Act
      const result = parseServiceDiscovery(event);

      // Assert
      expect(result).toBeNull();
    });

    it('returns null when supportedKinds contains floating-point numbers', () => {
      // Arrange: supportedKinds has a float (event kinds must be integers)
      const event = {
        kind: 10035,
        content: JSON.stringify({
          serviceType: 'relay',
          ilpAddress: 'g.crosstown.test',
          pricing: { basePricePerByte: 10, currency: 'USDC' },
          supportedKinds: [1, 1.5, 10036],
          capabilities: ['relay'],
          chain: 'anvil',
          version: '0.1.0',
        }),
        tags: [['d', 'crosstown-service-discovery']],
        created_at: Math.floor(Date.now() / 1000),
        pubkey: 'a'.repeat(64),
        id: 'b'.repeat(64),
        sig: 'c'.repeat(128),
      };

      // Act
      const result = parseServiceDiscovery(event);

      // Assert: floats are not valid event kinds
      expect(result).toBeNull();
    });

    it('returns null when supportedKinds contains negative numbers', () => {
      // Arrange: supportedKinds has a negative value
      const event = {
        kind: 10035,
        content: JSON.stringify({
          serviceType: 'relay',
          ilpAddress: 'g.crosstown.test',
          pricing: { basePricePerByte: 10, currency: 'USDC' },
          supportedKinds: [1, -5, 10036],
          capabilities: ['relay'],
          chain: 'anvil',
          version: '0.1.0',
        }),
        tags: [['d', 'crosstown-service-discovery']],
        created_at: Math.floor(Date.now() / 1000),
        pubkey: 'a'.repeat(64),
        id: 'b'.repeat(64),
        sig: 'c'.repeat(128),
      };

      // Act
      const result = parseServiceDiscovery(event);

      // Assert: negative numbers are not valid event kinds
      expect(result).toBeNull();
    });

    it('returns null when capabilities contains non-strings', () => {
      // Arrange: capabilities has a numeric element
      const event = {
        kind: 10035,
        content: JSON.stringify({
          serviceType: 'relay',
          ilpAddress: 'g.crosstown.test',
          pricing: { basePricePerByte: 10, currency: 'USDC' },
          supportedKinds: [1],
          capabilities: ['relay', 42],
          chain: 'anvil',
          version: '0.1.0',
        }),
        tags: [['d', 'crosstown-service-discovery']],
        created_at: Math.floor(Date.now() / 1000),
        pubkey: 'a'.repeat(64),
        id: 'b'.repeat(64),
        sig: 'c'.repeat(128),
      };

      // Act
      const result = parseServiceDiscovery(event);

      // Assert
      expect(result).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // AC #1, #2: buildServiceDiscoveryEvent() content serialization round-trip
  // --------------------------------------------------------------------------
  describe('buildServiceDiscoveryEvent() content serialization (AC #1, #2)', () => {
    it('serializes content as JSON that round-trips through parse', () => {
      // Arrange: build content with all fields including x402
      const secretKey = generateSecretKey();
      const content = createServiceDiscoveryContent({
        serviceType: 'rig',
        ilpAddress: 'g.crosstown.custom-node',
        chain: 'arbitrum-sepolia',
        version: '1.2.3',
      });

      // Act: build event, parse the raw JSON from event.content
      const event = buildServiceDiscoveryEvent(content, secretKey);
      const rawParsed = JSON.parse(event.content) as Record<string, unknown>;

      // Assert: raw JSON matches the input content structure
      expect(rawParsed['serviceType']).toBe('rig');
      expect(rawParsed['ilpAddress']).toBe('g.crosstown.custom-node');
      expect(rawParsed['chain']).toBe('arbitrum-sepolia');
      expect(rawParsed['version']).toBe('1.2.3');
    });

    it('omits x402 key entirely from serialized JSON when not in content', () => {
      // Arrange: ILP-only content (no x402 field)
      const secretKey = generateSecretKey();
      const content = createIlpOnlyContent();

      // Act: build event, check raw JSON keys
      const event = buildServiceDiscoveryEvent(content, secretKey);
      const rawParsed = JSON.parse(event.content) as Record<string, unknown>;

      // Assert: x402 key is not present in the serialized JSON
      expect('x402' in rawParsed).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // AC #4: buildServiceDiscoveryEvent() tags structure
  // --------------------------------------------------------------------------
  describe('buildServiceDiscoveryEvent() tags structure (AC #4)', () => {
    it('includes exactly one tag (the d tag)', () => {
      // Arrange
      const secretKey = generateSecretKey();
      const content = createServiceDiscoveryContent();

      // Act
      const event = buildServiceDiscoveryEvent(content, secretKey);

      // Assert: exactly one tag, and it's the d tag
      expect(event.tags).toHaveLength(1);
      expect(event.tags[0]).toEqual(['d', 'crosstown-service-discovery']);
    });
  });

  // --------------------------------------------------------------------------
  // AC #1: buildServiceDiscoveryEvent() Schnorr signature verification
  // --------------------------------------------------------------------------
  describe('buildServiceDiscoveryEvent() signature verification (AC #1)', () => {
    it('produces an event that passes verifyEvent()', () => {
      // Arrange
      const secretKey = generateSecretKey();
      const content = createServiceDiscoveryContent();

      // Act
      const event = buildServiceDiscoveryEvent(content, secretKey);
      const isValid = verifyEvent(event);

      // Assert: event passes Schnorr signature verification
      expect(isValid).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // AC #2: parseServiceDiscovery() -- pricing as array (defensive)
  // --------------------------------------------------------------------------
  describe('parseServiceDiscovery() pricing as array (AC #2)', () => {
    it('returns null when pricing is an array instead of object', () => {
      // Arrange: pricing is an array (arrays are objects in JS)
      const event = {
        kind: 10035,
        content: JSON.stringify({
          serviceType: 'relay',
          ilpAddress: 'g.crosstown.test',
          pricing: [10, 'USDC'],
          supportedKinds: [1],
          capabilities: ['relay'],
          chain: 'anvil',
          version: '0.1.0',
        }),
        tags: [['d', 'crosstown-service-discovery']],
        created_at: Math.floor(Date.now() / 1000),
        pubkey: 'a'.repeat(64),
        id: 'b'.repeat(64),
        sig: 'c'.repeat(128),
      };

      // Act
      const result = parseServiceDiscovery(event);

      // Assert: arrays are not valid pricing objects
      expect(result).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // AC #2: parseServiceDiscovery() -- x402 as array (defensive)
  // --------------------------------------------------------------------------
  describe('parseServiceDiscovery() x402 as array (AC #2)', () => {
    it('returns null when x402 is an array instead of object', () => {
      // Arrange: x402 is an array (arrays are objects in JS)
      const event = {
        kind: 10035,
        content: JSON.stringify({
          serviceType: 'relay',
          ilpAddress: 'g.crosstown.test',
          pricing: { basePricePerByte: 10, currency: 'USDC' },
          supportedKinds: [1],
          capabilities: ['relay'],
          chain: 'anvil',
          version: '0.1.0',
          x402: [true, '/publish'],
        }),
        tags: [['d', 'crosstown-service-discovery']],
        created_at: Math.floor(Date.now() / 1000),
        pubkey: 'a'.repeat(64),
        id: 'b'.repeat(64),
        sig: 'c'.repeat(128),
      };

      // Act
      const result = parseServiceDiscovery(event);

      // Assert: arrays are not valid x402 objects
      expect(result).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // AC #2: parseServiceDiscovery() -- basePricePerByte edge cases (defensive)
  // --------------------------------------------------------------------------
  describe('parseServiceDiscovery() basePricePerByte validation (AC #2)', () => {
    it('returns null when basePricePerByte is NaN', () => {
      const event = {
        kind: 10035,
        content: JSON.stringify({
          serviceType: 'relay',
          ilpAddress: 'g.crosstown.test',
          pricing: { basePricePerByte: NaN, currency: 'USDC' },
          supportedKinds: [1],
          capabilities: ['relay'],
          chain: 'anvil',
          version: '0.1.0',
        }),
        tags: [['d', 'crosstown-service-discovery']],
        created_at: Math.floor(Date.now() / 1000),
        pubkey: 'a'.repeat(64),
        id: 'b'.repeat(64),
        sig: 'c'.repeat(128),
      };

      const result = parseServiceDiscovery(event);
      expect(result).toBeNull();
    });

    it('returns null when basePricePerByte is negative', () => {
      const event = {
        kind: 10035,
        content: JSON.stringify({
          serviceType: 'relay',
          ilpAddress: 'g.crosstown.test',
          pricing: { basePricePerByte: -5, currency: 'USDC' },
          supportedKinds: [1],
          capabilities: ['relay'],
          chain: 'anvil',
          version: '0.1.0',
        }),
        tags: [['d', 'crosstown-service-discovery']],
        created_at: Math.floor(Date.now() / 1000),
        pubkey: 'a'.repeat(64),
        id: 'b'.repeat(64),
        sig: 'c'.repeat(128),
      };

      const result = parseServiceDiscovery(event);
      expect(result).toBeNull();
    });

    it('returns null when basePricePerByte is Infinity', () => {
      const event = {
        kind: 10035,
        content: JSON.stringify({
          serviceType: 'relay',
          ilpAddress: 'g.crosstown.test',
          pricing: { basePricePerByte: Infinity, currency: 'USDC' },
          supportedKinds: [1],
          capabilities: ['relay'],
          chain: 'anvil',
          version: '0.1.0',
        }),
        tags: [['d', 'crosstown-service-discovery']],
        created_at: Math.floor(Date.now() / 1000),
        pubkey: 'a'.repeat(64),
        id: 'b'.repeat(64),
        sig: 'c'.repeat(128),
      };

      const result = parseServiceDiscovery(event);
      expect(result).toBeNull();
    });

    it('accepts basePricePerByte of zero', () => {
      const event = {
        kind: 10035,
        content: JSON.stringify({
          serviceType: 'relay',
          ilpAddress: 'g.crosstown.test',
          pricing: { basePricePerByte: 0, currency: 'USDC' },
          supportedKinds: [1],
          capabilities: ['relay'],
          chain: 'anvil',
          version: '0.1.0',
        }),
        tags: [['d', 'crosstown-service-discovery']],
        created_at: Math.floor(Date.now() / 1000),
        pubkey: 'a'.repeat(64),
        id: 'b'.repeat(64),
        sig: 'c'.repeat(128),
      };

      const result = parseServiceDiscovery(event);
      expect(result).not.toBeNull();
      expect(result!.pricing.basePricePerByte).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // AC #2: parseServiceDiscovery() -- forward compatibility (extra fields)
  // --------------------------------------------------------------------------
  describe('parseServiceDiscovery() forward compatibility (AC #2)', () => {
    it('parses content with extra unknown fields (forward compatible)', () => {
      // Arrange: content has all required fields plus extra unknown fields
      const event = {
        kind: 10035,
        content: JSON.stringify({
          serviceType: 'relay',
          ilpAddress: 'g.crosstown.test',
          pricing: { basePricePerByte: 10, currency: 'USDC' },
          supportedKinds: [1, 10032, 10036],
          capabilities: ['relay'],
          chain: 'anvil',
          version: '0.1.0',
          futureField: 'some-value',
          anotherField: { nested: true },
        }),
        tags: [['d', 'crosstown-service-discovery']],
        created_at: Math.floor(Date.now() / 1000),
        pubkey: 'a'.repeat(64),
        id: 'b'.repeat(64),
        sig: 'c'.repeat(128),
      };

      // Act
      const result = parseServiceDiscovery(event);

      // Assert: parser succeeds and extracts known fields
      expect(result).not.toBeNull();
      expect(result!.serviceType).toBe('relay');
      expect(result!.ilpAddress).toBe('g.crosstown.test');
      expect(result!.chain).toBe('anvil');
    });
  });
});

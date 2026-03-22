/**
 * ATDD tests for Story 8.0: Service Discovery for kind:5094
 *
 * Test ID: 8.0-UNIT-012
 *
 * AC covered:
 * - AC #4: Provider service discovery
 */

import { describe, it, expect, vi } from 'vitest';

import { buildSkillDescriptor } from '../skill-descriptor.js';
import { HandlerRegistry } from '../handler-registry.js';

// ============================================================================
// 8.0-UNIT-012: SkillDescriptor includes kind:5094 (AC #4)
// ============================================================================

describe('Service Discovery for kind:5094 (Story 8.0)', () => {
  it('[P0] kindPricing[5094] -> SkillDescriptor includes kinds: [5094] and pricing', () => {
    // Arrange: configure a handler registry with kind 5094 and kindPricing
    const registry = new HandlerRegistry();
    const mockHandler = vi.fn().mockResolvedValue({ accept: true });
    registry.on(5094, mockHandler);

    const kindPricing: Record<number, bigint> = { 5094: 100n };
    const basePricePerByte = 10n;

    // Act
    const descriptor = buildSkillDescriptor(registry, {
      kindPricing,
      basePricePerByte,
    });

    // Assert
    expect(descriptor).toBeDefined();
    expect(descriptor!.kinds).toContain(5094);
    expect(descriptor!.pricing).toBeDefined();
    expect(descriptor!.pricing!['5094']).toBe('100');
  });

  it('[P1] no kind:5094 handler registered -> SkillDescriptor does not include 5094', () => {
    // Arrange: registry with only kind 5100
    const registry = new HandlerRegistry();
    const mockHandler = vi.fn().mockResolvedValue({ accept: true });
    registry.on(5100, mockHandler);
    const kindPricing: Record<number, bigint> = { 5100: 50n };

    // Act
    const descriptor = buildSkillDescriptor(registry, {
      kindPricing,
      basePricePerByte: 10n,
    });

    // Assert
    expect(descriptor).toBeDefined();
    expect(descriptor!.kinds).not.toContain(5094);
  });
});

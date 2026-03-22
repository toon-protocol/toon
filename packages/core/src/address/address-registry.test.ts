/**
 * Unit Tests: AddressRegistry (Story 7.3, Task 9)
 *
 * Tests the upstream prefix -> derived address mapping used for
 * address lifecycle tracking in multi-peered nodes.
 */

import { describe, it, expect } from 'vitest';
import { AddressRegistry } from './address-registry.js';

describe('AddressRegistry (Story 7.3)', () => {
  // -------------------------------------------------------------------------
  // Task 9.1: addAddress + getAddresses
  // -------------------------------------------------------------------------

  it('addAddress() adds an upstream prefix -> derived address mapping; getAddresses() returns it (Task 9.1)', () => {
    // Arrange
    const registry = new AddressRegistry();

    // Act
    registry.addAddress('g.toon.useast', 'g.toon.useast.abcd1234');

    // Assert
    expect(registry.getAddresses()).toEqual(['g.toon.useast.abcd1234']);
  });

  it('addAddress() with same prefix overwrites the previous derived address', () => {
    // Arrange
    const registry = new AddressRegistry();
    registry.addAddress('g.toon.useast', 'g.toon.useast.abcd1234');

    // Act -- overwrite with a new derived address for the same prefix
    registry.addAddress('g.toon.useast', 'g.toon.useast.ffff9999');

    // Assert -- only one entry; the latest value wins
    expect(registry.getAddresses()).toEqual(['g.toon.useast.ffff9999']);
  });

  // -------------------------------------------------------------------------
  // Task 9.2: removeAddress returns removed address
  // -------------------------------------------------------------------------

  it('removeAddress() removes the mapping and returns the removed address (Task 9.2)', () => {
    // Arrange
    const registry = new AddressRegistry();
    registry.addAddress('g.toon.useast', 'g.toon.useast.abcd1234');

    // Act
    const removed = registry.removeAddress('g.toon.useast');

    // Assert
    expect(removed).toBe('g.toon.useast.abcd1234');
    expect(registry.getAddresses()).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Task 9.3: removeAddress with unknown prefix
  // -------------------------------------------------------------------------

  it('removeAddress() with unknown prefix returns undefined (Task 9.3)', () => {
    // Arrange
    const registry = new AddressRegistry();
    registry.addAddress('g.toon.useast', 'g.toon.useast.abcd1234');

    // Act
    const removed = registry.removeAddress('g.toon.unknown');

    // Assert
    expect(removed).toBeUndefined();
    expect(registry.getAddresses()).toEqual(['g.toon.useast.abcd1234']);
  });

  // -------------------------------------------------------------------------
  // Task 9.4: insertion order
  // -------------------------------------------------------------------------

  it('getAddresses() returns addresses in insertion order (Task 9.4)', () => {
    // Arrange
    const registry = new AddressRegistry();

    // Act -- add in specific order
    registry.addAddress('g.toon.useast', 'g.toon.useast.abcd1234');
    registry.addAddress('g.toon.euwest', 'g.toon.euwest.abcd1234');
    registry.addAddress('g.toon.apac', 'g.toon.apac.abcd1234');

    // Assert -- order preserved
    expect(registry.getAddresses()).toEqual([
      'g.toon.useast.abcd1234',
      'g.toon.euwest.abcd1234',
      'g.toon.apac.abcd1234',
    ]);
  });

  // -------------------------------------------------------------------------
  // Task 9.5: getPrimaryAddress
  // -------------------------------------------------------------------------

  it('getPrimaryAddress() returns undefined when registry is empty', () => {
    // Arrange
    const registry = new AddressRegistry();

    // Act
    const primary = registry.getPrimaryAddress();

    // Assert
    expect(primary).toBeUndefined();
  });

  it('getPrimaryAddress() returns the first inserted address (Task 9.5)', () => {
    // Arrange
    const registry = new AddressRegistry();
    registry.addAddress('g.toon.useast', 'g.toon.useast.abcd1234');
    registry.addAddress('g.toon.euwest', 'g.toon.euwest.abcd1234');

    // Act
    const primary = registry.getPrimaryAddress();

    // Assert
    expect(primary).toBe('g.toon.useast.abcd1234');
  });

  // -------------------------------------------------------------------------
  // Task 9.6: remove all + re-add
  // -------------------------------------------------------------------------

  it('after removing all addresses and re-adding, getPrimaryAddress() returns the new first address (Task 9.6)', () => {
    // Arrange
    const registry = new AddressRegistry();
    registry.addAddress('g.toon.useast', 'g.toon.useast.abcd1234');
    registry.addAddress('g.toon.euwest', 'g.toon.euwest.abcd1234');

    // Act -- remove all
    registry.removeAddress('g.toon.useast');
    registry.removeAddress('g.toon.euwest');

    // Re-add in different order
    registry.addAddress('g.toon.apac', 'g.toon.apac.abcd1234');
    registry.addAddress('g.toon.uswest', 'g.toon.uswest.abcd1234');

    // Assert
    expect(registry.getPrimaryAddress()).toBe('g.toon.apac.abcd1234');
    expect(registry.getAddresses()).toEqual([
      'g.toon.apac.abcd1234',
      'g.toon.uswest.abcd1234',
    ]);
  });
});

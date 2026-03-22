/**
 * AddressRegistry tracks upstream prefix -> derived ILP address mappings.
 *
 * Used by multi-peered nodes to manage address lifecycle: when an upstream
 * peer connects, the node derives and registers an address; when the peer
 * disconnects, the address is removed and kind:10032 republished.
 *
 * Addresses are returned in insertion order so that the primary address
 * (first inserted) is stable across lifecycle events.
 *
 * @module
 */

/**
 * Tracks the mapping from upstream ILP prefix to derived ILP address.
 *
 * Uses a `Map<string, string>` internally, which preserves insertion order
 * per the ECMAScript specification.
 */
export class AddressRegistry {
  private readonly prefixToAddress = new Map<string, string>();

  /**
   * Registers a new upstream prefix -> derived address mapping.
   *
   * @param upstreamPrefix - The upstream peer's ILP address prefix
   * @param derivedAddress - The derived ILP address for this node under that prefix
   */
  addAddress(upstreamPrefix: string, derivedAddress: string): void {
    this.prefixToAddress.set(upstreamPrefix, derivedAddress);
  }

  /**
   * Removes the mapping for the given upstream prefix.
   *
   * @param upstreamPrefix - The upstream prefix to remove
   * @returns The removed derived address, or `undefined` if the prefix was not found
   */
  removeAddress(upstreamPrefix: string): string | undefined {
    const address = this.prefixToAddress.get(upstreamPrefix);
    if (address !== undefined) {
      this.prefixToAddress.delete(upstreamPrefix);
    }
    return address;
  }

  /**
   * Returns all derived addresses in insertion order.
   */
  getAddresses(): string[] {
    return [...this.prefixToAddress.values()];
  }

  /**
   * Returns `true` if the given upstream prefix is registered.
   */
  hasPrefix(upstreamPrefix: string): boolean {
    return this.prefixToAddress.has(upstreamPrefix);
  }

  /**
   * Returns the number of registered addresses.
   */
  get size(): number {
    return this.prefixToAddress.size;
  }

  /**
   * Returns the primary (first inserted) address.
   *
   * @returns The first address, or `undefined` if the registry is empty
   */
  getPrimaryAddress(): string | undefined {
    const first = this.prefixToAddress.values().next();
    return first.done ? undefined : first.value;
  }
}

/**
 * Event storage handler stub for @toon-protocol/sdk.
 *
 * This is a stub that throws. The real implementation lives in
 * `@toon-protocol/relay` -- see `createEventStorageHandler` from that package.
 *
 * The SDK is the framework; Relay is the relay implementation. SDK consumers
 * building relay functionality should use `@toon-protocol/relay` directly.
 */

/**
 * Creates an event storage handler.
 *
 * **Stub** -- throws "not yet implemented". See `@toon-protocol/relay` for the
 * real relay implementation of this handler.
 *
 * @see {@link https://github.com/toon-protocol/relay | @toon-protocol/relay}
 */
export function createEventStorageHandler(_config: unknown): unknown {
  throw new Error(
    'createEventStorageHandler is not yet implemented in @toon-protocol/sdk. ' +
      'Use @toon-protocol/relay for the relay implementation.'
  );
}

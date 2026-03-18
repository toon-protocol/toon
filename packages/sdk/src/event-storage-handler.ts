/**
 * Event storage handler stub for @toon-protocol/sdk.
 *
 * This is a stub that throws. The real implementation lives in
 * `@toon-protocol/town` -- see `createEventStorageHandler` from that package.
 *
 * The SDK is the framework; Town is the relay implementation. SDK consumers
 * building relay functionality should use `@toon-protocol/town` directly.
 */

/**
 * Creates an event storage handler.
 *
 * **Stub** -- throws "not yet implemented". See `@toon-protocol/town` for the
 * real relay implementation of this handler.
 *
 * @see {@link https://github.com/ALLiDoizCode/toon/tree/main/packages/town | @toon-protocol/town}
 */
export function createEventStorageHandler(_config: unknown): unknown {
  throw new Error(
    'createEventStorageHandler is not yet implemented in @toon-protocol/sdk. ' +
      'Use @toon-protocol/town for the relay implementation.'
  );
}

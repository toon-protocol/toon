/**
 * SPSP handshake handler stub for @crosstown/sdk.
 *
 * This is a stub that throws. The real implementation lives in
 * `@crosstown/town` -- see `createSpspHandshakeHandler` from that package.
 *
 * The SDK is the framework; Town is the relay implementation. SDK consumers
 * building relay functionality should use `@crosstown/town` directly.
 */

/**
 * Creates an SPSP handshake handler.
 *
 * **Stub** -- throws "not yet implemented". See `@crosstown/town` for the
 * real relay implementation of this handler.
 *
 * @see {@link https://github.com/ALLiDoizCode/crosstown/tree/main/packages/town | @crosstown/town}
 */
export function createSpspHandshakeHandler(_config: unknown): unknown {
  throw new Error(
    'createSpspHandshakeHandler is not yet implemented in @crosstown/sdk. ' +
      'Use @crosstown/town for the relay implementation.'
  );
}

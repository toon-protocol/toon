/**
 * Handler registry for @crosstown/sdk.
 *
 * Maps event kinds to handler functions for dispatching incoming ILP packets.
 */

import type { HandlerContext } from './handler-context.js';

export type Handler = (
  ctx: HandlerContext
) => Promise<{ accept: boolean; [key: string]: unknown }>;

/**
 * Registry that maps Nostr event kinds to handler functions.
 */
export class HandlerRegistry {
  private handlers = new Map<number, Handler>();
  private defaultHandler: Handler | undefined;

  /**
   * Register a handler for a specific event kind.
   * Replaces any existing handler for that kind.
   */
  on(kind: number, handler: Handler): void {
    this.handlers.set(kind, handler);
  }

  /**
   * Register a default handler for unrecognized kinds.
   */
  onDefault(handler: Handler): void {
    this.defaultHandler = handler;
  }

  /**
   * Dispatch a context to the appropriate handler based on kind.
   */
  async dispatch(
    ctx: HandlerContext
  ): Promise<{ accept: boolean; [key: string]: unknown }> {
    const handler = this.handlers.get(ctx.kind);
    if (handler) {
      return handler(ctx);
    }
    if (this.defaultHandler) {
      return this.defaultHandler(ctx);
    }
    return {
      accept: false,
      code: 'F00',
      message: `No handler registered for kind ${ctx.kind}`,
    };
  }
}

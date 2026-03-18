/**
 * Handler registry for @toon-protocol/sdk.
 *
 * Maps event kinds to handler functions for dispatching incoming ILP packets.
 */

import { JOB_REQUEST_KIND_BASE } from '@toon-protocol/core';
import type {
  HandlerContext,
  HandlePacketAcceptResponse,
  HandlePacketRejectResponse,
} from './handler-context.js';

export type HandlerResponse =
  | HandlePacketAcceptResponse
  | HandlePacketRejectResponse;

export type Handler = (ctx: HandlerContext) => Promise<HandlerResponse>;

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
  on(kind: number, handler: Handler): this {
    this.handlers.set(kind, handler);
    return this;
  }

  /**
   * Register a default handler for unrecognized kinds.
   */
  onDefault(handler: Handler): this {
    this.defaultHandler = handler;
    return this;
  }

  /**
   * Returns all registered kind numbers, sorted ascending.
   */
  getRegisteredKinds(): number[] {
    return [...this.handlers.keys()].sort((a, b) => a - b);
  }

  /**
   * Returns registered kinds in the DVM request range (5000-5999), sorted ascending.
   * Uses JOB_REQUEST_KIND_BASE (5000) as the range start.
   */
  getDvmKinds(): number[] {
    const dvmRangeStart = JOB_REQUEST_KIND_BASE;
    const dvmRangeEnd = JOB_REQUEST_KIND_BASE + 999;
    return this.getRegisteredKinds().filter(
      (k) => k >= dvmRangeStart && k <= dvmRangeEnd
    );
  }

  /**
   * Dispatch a context to the appropriate handler based on kind.
   */
  async dispatch(ctx: HandlerContext): Promise<HandlerResponse> {
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

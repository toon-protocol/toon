/**
 * App intake: serves a connector's delivery to an app.
 *
 * The connector has terminated the payment and reverse-proxies a plain HTTP
 * request, stating the verified payment in `X-TOON-Payer`, `X-TOON-Amount` and
 * `X-TOON-Chain`. The intake parses `{ event }`, checks the signature, runs the
 * handler for the event's kind and maps its answer to a wire code and status.
 *
 * It knows nothing about price, payload limits or claims: those belong to the
 * connector. The stated payment is read, never checked.
 */

import { verifyEvent } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';

/** The payment the connector stated in the `X-TOON-*` headers. */
export interface StatedPayment {
  payer?: string;
  /** Absent when the header is missing or not a non-negative integer. */
  amount?: bigint;
  chain?: string;
}

/** What a handler returns: accepted with data, or refused with a code. */
export type AppIntakeAnswer =
  | {
      accept: true;
      /** Base64 payload returned to the sender. */
      data?: string;
      /** Extra fields merged into the response body (e.g. `txId`); they cannot override `accept`, `data` or the stated payment. */
      fields?: Record<string, unknown>;
    }
  | { accept: false; code: string; message: string };

export type AppIntakeHandler = (
  event: NostrEvent,
  payment: StatedPayment
) => Promise<AppIntakeAnswer> | AppIntakeAnswer;

export interface AppIntakeLogger {
  info(message: string): void;
  error(message: string): void;
}

export interface AppIntakeConfig {
  /** Handlers by event kind. */
  handlers: Record<number, AppIntakeHandler> | Map<number, AppIntakeHandler>;
  /** Used for a kind with no handler; without it such a kind is refused. */
  defaultHandler?: AppIntakeHandler;
  /** Skip the signature check. */
  devMode?: boolean;
  /** Prefix for the one log line per job, e.g. `store`. */
  logPrefix?: string;
  logger?: AppIntakeLogger;
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function refuse(code: string, message: string): Response {
  return json(code === 'F00' ? 422 : 502, { accept: false, code, message });
}

/** `verifyEvent` throws on an event missing its fields; that is a bad signature too. */
function isValidSignature(event: NostrEvent): boolean {
  try {
    return verifyEvent(event);
  } catch {
    return false;
  }
}

function readPayment(headers: Headers): StatedPayment {
  const payment: StatedPayment = {};
  const payer = headers.get('x-toon-payer');
  if (payer) payment.payer = payer;
  const amount = headers.get('x-toon-amount');
  if (amount !== null && /^\d+$/.test(amount.trim())) {
    payment.amount = BigInt(amount.trim());
  }
  const chain = headers.get('x-toon-chain');
  if (chain) payment.chain = chain;
  return payment;
}

/** Create a web-standard `fetch` handler serving the app intake. */
export function createAppIntake(
  config: AppIntakeConfig
): (request: Request) => Promise<Response> {
  const handlers =
    config.handlers instanceof Map
      ? config.handlers
      : new Map(
          Object.entries(config.handlers).map(
            ([k, h]) => [Number(k), h] as const
          )
        );
  const prefix = config.logPrefix ?? 'app';
  const logger: AppIntakeLogger = config.logger ?? console;

  return async (request: Request): Promise<Response> => {
    if (
      request.method === 'GET' &&
      new URL(request.url).pathname === '/health'
    ) {
      return json(200, { status: 'ok' });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      body = undefined;
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return refuse('F00', 'Invalid request body');
    }
    const event = (body as { event?: unknown }).event;
    if (typeof event !== 'object' || event === null) {
      return refuse('F00', 'Missing required field: event');
    }
    const nostrEvent = event as NostrEvent;

    if (!config.devMode && !isValidSignature(nostrEvent)) {
      return refuse('F00', 'Invalid event signature');
    }

    const payment = readPayment(request.headers);
    const handler = handlers.get(nostrEvent.kind) ?? config.defaultHandler;
    if (!handler) {
      const served = [...handlers.keys()].join(', ');
      return refuse(
        'F00',
        `No handler for event kind ${String(nostrEvent.kind)}. Supported kinds: ${served}`
      );
    }

    const logJob = (outcome: string): void =>
      logger.info(
        `[${prefix}] kind=${String(nostrEvent.kind)} id=${String(nostrEvent.id)} payer=${payment.payer ?? '-'} amount=${payment.amount?.toString() ?? '-'} chain=${payment.chain ?? '-'} outcome=${outcome}`
      );

    let answer: AppIntakeAnswer;
    try {
      answer = await handler(nostrEvent, payment);
    } catch (err) {
      logger.error(
        `[${prefix}] handler threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`
      );
      logJob('T00');
      return refuse('T00', 'Internal handler error');
    }

    if (!answer.accept) {
      logJob(answer.code);
      return refuse(answer.code, answer.message);
    }
    logJob('accepted');
    return json(200, {
      ...answer.fields,
      accept: true,
      data: answer.data,
      payer: payment.payer,
      amount: payment.amount?.toString(),
      chain: payment.chain,
    });
  };
}

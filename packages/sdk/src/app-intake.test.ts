import { describe, it, expect, vi } from 'vitest';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { createAppIntake } from './app-intake.js';
import type { AppIntakeHandler } from './app-intake.js';

const sk = generateSecretKey();
const signed = (kind = 5094) =>
  finalizeEvent({ kind, created_at: 1, tags: [], content: 'hi' }, sk);

const quiet = { info: vi.fn(), error: vi.fn() };

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://app/handle-packet', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const ok: AppIntakeHandler = () => ({ accept: true, data: 'ZGF0YQ==' });

function intake(
  extra: Partial<Parameters<typeof createAppIntake>[0]> = {}
): (r: Request) => Promise<Response> {
  return createAppIntake({
    handlers: { 5094: ok },
    logger: quiet,
    ...extra,
  });
}

describe('createAppIntake', () => {
  describe('body shapes', () => {
    it.each([
      ['not json', 'nope', 'Invalid request body'],
      ['array', '[]', 'Invalid request body'],
      ['null', 'null', 'Invalid request body'],
      ['no event', {}, 'Missing required field: event'],
      ['non-object event', { event: 'x' }, 'Missing required field: event'],
    ])('%s -> F00/422', async (_n, body, message) => {
      const res = await intake()(post(body));
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ accept: false, code: 'F00', message });
    });

    it('serves a valid event', async () => {
      const res = await intake()(post({ event: signed() }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ accept: true, data: 'ZGF0YQ==' });
    });
  });

  describe('signature', () => {
    it('refuses a bad signature', async () => {
      const event = { ...signed(), content: 'tampered' };
      const res = await intake()(post({ event }));
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({
        accept: false,
        code: 'F00',
        message: 'Invalid event signature',
      });
    });

    it('dev mode skips the check', async () => {
      const event = { ...signed(), sig: 'bad' };
      const res = await intake({ devMode: true })(post({ event }));
      expect(res.status).toBe(200);
    });
  });

  describe('dispatch', () => {
    it('runs the handler registered for the kind', async () => {
      const handler = vi.fn<
        Parameters<AppIntakeHandler>,
        ReturnType<AppIntakeHandler>
      >(() => ({ accept: true }));
      const event = signed(7);
      await intake({ handlers: new Map([[7, handler]]) })(post({ event }));
      expect(handler).toHaveBeenCalledWith(event, {});
    });

    it('refuses an unknown kind naming the kinds served', async () => {
      const res = await intake()(post({ event: signed(1) }));
      expect(res.status).toBe(422);
      const body = (await res.json()) as { code: string; message: string };
      expect(body.code).toBe('F00');
      expect(body.message).toContain('5094');
    });

    it('sends an unknown kind to the default handler', async () => {
      const defaultHandler = vi.fn<
        Parameters<AppIntakeHandler>,
        ReturnType<AppIntakeHandler>
      >(() => ({ accept: true, data: 'eA==' }));
      const res = await intake({ defaultHandler })(post({ event: signed(1) }));
      expect(res.status).toBe(200);
      expect(defaultHandler).toHaveBeenCalledOnce();
    });
  });

  describe('answers', () => {
    it('accept carries data, stated payment and extra fields', async () => {
      const res = await intake({
        handlers: {
          5094: () => ({
            accept: true,
            data: 'ZGF0YQ==',
            fields: { txId: 'abc' },
          }),
        },
      })(
        post(
          { event: signed() },
          {
            'x-toon-payer': 'payer1',
            'x-toon-amount': '42',
            'x-toon-chain': 'solana',
          }
        )
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        accept: true,
        data: 'ZGF0YQ==',
        payer: 'payer1',
        amount: '42',
        chain: 'solana',
        txId: 'abc',
      });
    });

    it('F00 refusal is 422', async () => {
      const res = await intake({
        handlers: {
          5094: () => ({ accept: false, code: 'F00', message: 'bad' }),
        },
      })(post({ event: signed() }));
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({
        accept: false,
        code: 'F00',
        message: 'bad',
      });
    });

    it('other refusal is 502', async () => {
      const res = await intake({
        handlers: {
          5094: () => ({ accept: false, code: 'T01', message: 'down' }),
        },
      })(post({ event: signed() }));
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({
        accept: false,
        code: 'T01',
        message: 'down',
      });
    });

    it('thrown handler is T00/502 and logged', async () => {
      const logger = { info: vi.fn(), error: vi.fn() };
      const res = await intake({
        logger,
        handlers: {
          5094: () => {
            throw new Error('boom');
          },
        },
      })(post({ event: signed() }));
      expect(res.status).toBe(502);
      expect(((await res.json()) as { code: string }).code).toBe('T00');
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('boom')
      );
    });
  });

  describe('stated payment', () => {
    it('reaches the handler as given', async () => {
      const handler = vi.fn<
        Parameters<AppIntakeHandler>,
        ReturnType<AppIntakeHandler>
      >(() => ({ accept: true }));
      await intake({ handlers: { 5094: handler } })(
        post(
          { event: signed() },
          {
            'x-toon-payer': 'p',
            'x-toon-amount': '10',
            'x-toon-chain': 'evm:1',
          }
        )
      );
      expect(handler.mock.calls[0]?.[1]).toEqual({
        payer: 'p',
        amount: 10n,
        chain: 'evm:1',
      });
    });

    it.each([
      ['absent', undefined],
      ['unparseable', 'abc'],
      ['negative', '-5'],
    ])('%s amount reads as absent', async (_n, amount) => {
      const handler = vi.fn<
        Parameters<AppIntakeHandler>,
        ReturnType<AppIntakeHandler>
      >(() => ({ accept: true }));
      await intake({ handlers: { 5094: handler } })(
        post({ event: signed() }, amount ? { 'x-toon-amount': amount } : {})
      );
      expect(handler.mock.calls[0]?.[1]).toEqual({});
    });
  });

  describe('health and logging', () => {
    it('GET /health answers ok', async () => {
      const res = await intake()(new Request('http://app/health'));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok' });
    });

    it('logs one line per job under the prefix', async () => {
      const logger = { info: vi.fn(), error: vi.fn() };
      await intake({ logger, logPrefix: 'store' })(post({ event: signed() }));
      expect(logger.info).toHaveBeenCalledOnce();
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringMatching(/^\[store\] kind=5094 .*outcome=accepted/)
      );
    });
  });

  // Parity with store's src/store-backend.test.ts cases (status + body).
  describe('parity with store backend', () => {
    const parity: [string, () => Request, number, Record<string, unknown>][] = [
      [
        'invalid body',
        () => post('[1]'),
        422,
        { accept: false, code: 'F00', message: 'Invalid request body' },
      ],
      [
        'missing event',
        () => post({}),
        422,
        {
          accept: false,
          code: 'F00',
          message: 'Missing required field: event',
        },
      ],
      [
        'bad signature',
        () => post({ event: { ...signed(), id: 'f'.repeat(64) } }),
        422,
        { accept: false, code: 'F00', message: 'Invalid event signature' },
      ],
    ];
    it.each(parity)('%s', async (_n, req, status, body) => {
      const res = await intake()(req());
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual(body);
    });
  });
});

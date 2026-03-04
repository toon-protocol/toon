/**
 * Tests for createHttpRuntimeClient — HTTP-based AgentRuntimeClient.
 *
 * Mocks fetch at the transport boundary. Tests the request shaping,
 * response normalization, and error handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createHttpRuntimeClient,
  createAgentRuntimeClient,
} from './agent-runtime-client.js';
import { BootstrapError } from './BootstrapService.js';

// ============================================================================
// Factories
// ============================================================================

function createFetchResponse(
  body: Record<string, unknown>,
  status = 200
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response;
}

// ============================================================================
// Tests
// ============================================================================

describe('createHttpRuntimeClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should export createAgentRuntimeClient as backward-compatible alias', () => {
    expect(createAgentRuntimeClient).toBe(createHttpRuntimeClient);
  });

  it('should throw BootstrapError for invalid baseUrl', () => {
    expect(() => createHttpRuntimeClient('not-a-url')).toThrow(BootstrapError);
  });

  it('should create client for valid baseUrl', () => {
    const client = createHttpRuntimeClient('http://localhost:3000');
    expect(client).toBeDefined();
    expect(client.sendIlpPacket).toBeInstanceOf(Function);
  });

  describe('sendIlpPacket', () => {
    it('should POST to /admin/ilp/send with correct body', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(
          createFetchResponse({ accepted: true, fulfillment: 'abc123' })
        );
      vi.stubGlobal('fetch', mockFetch);

      const client = createHttpRuntimeClient('http://localhost:3000');
      await client.sendIlpPacket({
        destination: 'g.test.peer',
        amount: '1000',
        data: 'AQID',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/admin/ilp/send',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            destination: 'g.test.peer',
            amount: '1000',
            data: 'AQID',
          }),
        })
      );
    });

    it('should return accepted result on FULFILL', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          createFetchResponse({
            accepted: true,
            fulfillment: 'abc123',
            data: 'AQID',
          })
        )
      );

      const client = createHttpRuntimeClient('http://localhost:3000');
      const result = await client.sendIlpPacket({
        destination: 'g.test.peer',
        amount: '1000',
        data: 'AQID',
      });

      expect(result.accepted).toBe(true);
      expect(result.fulfillment).toBe('abc123');
      expect(result.data).toBe('AQID');
    });

    it('should return REJECT result with code and message', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          createFetchResponse({
            accepted: false,
            code: 'F04',
            message: 'Insufficient amount',
          })
        )
      );

      const client = createHttpRuntimeClient('http://localhost:3000');
      const result = await client.sendIlpPacket({
        destination: 'g.test.peer',
        amount: '1000',
        data: 'AQID',
      });

      expect(result.accepted).toBe(false);
      expect(result.code).toBe('F04');
      expect(result.message).toBe('Insufficient amount');
    });

    it('should throw BootstrapError on HTTP error (500)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(createFetchResponse({}, 500))
      );

      const client = createHttpRuntimeClient('http://localhost:3000');
      await expect(
        client.sendIlpPacket({ destination: 'g.test', amount: '0', data: '' })
      ).rejects.toThrow(BootstrapError);
    });

    it('should throw BootstrapError on network error', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
      );

      const client = createHttpRuntimeClient('http://localhost:3000');
      await expect(
        client.sendIlpPacket({ destination: 'g.test', amount: '0', data: '' })
      ).rejects.toThrow(BootstrapError);
    });

    // Field name normalization: agent-runtime may return `fulfilled` or `accepted`
    describe('field name compatibility', () => {
      it('should normalize { fulfilled: true } to accepted === true', async () => {
        vi.stubGlobal(
          'fetch',
          vi
            .fn()
            .mockResolvedValue(
              createFetchResponse({ fulfilled: true, fulfillment: 'abc' })
            )
        );

        const client = createHttpRuntimeClient('http://localhost:3000');
        const result = await client.sendIlpPacket({
          destination: 'g.test',
          amount: '0',
          data: '',
        });

        expect(result.accepted).toBe(true);
      });

      it('should normalize { fulfilled: false } to accepted === false', async () => {
        vi.stubGlobal(
          'fetch',
          vi.fn().mockResolvedValue(createFetchResponse({ fulfilled: false }))
        );

        const client = createHttpRuntimeClient('http://localhost:3000');
        const result = await client.sendIlpPacket({
          destination: 'g.test',
          amount: '0',
          data: '',
        });

        expect(result.accepted).toBe(false);
      });

      it('should default to accepted === false when neither field present', async () => {
        vi.stubGlobal(
          'fetch',
          vi.fn().mockResolvedValue(createFetchResponse({}))
        );

        const client = createHttpRuntimeClient('http://localhost:3000');
        const result = await client.sendIlpPacket({
          destination: 'g.test',
          amount: '0',
          data: '',
        });

        expect(result.accepted).toBe(false);
      });

      it('should prefer accepted over fulfilled when both present', async () => {
        vi.stubGlobal(
          'fetch',
          vi
            .fn()
            .mockResolvedValue(
              createFetchResponse({ accepted: true, fulfilled: false })
            )
        );

        const client = createHttpRuntimeClient('http://localhost:3000');
        const result = await client.sendIlpPacket({
          destination: 'g.test',
          amount: '0',
          data: '',
        });

        expect(result.accepted).toBe(true);
      });
    });

    it('should include timeout in request body when provided', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(createFetchResponse({ accepted: true }));
      vi.stubGlobal('fetch', mockFetch);

      const client = createHttpRuntimeClient('http://localhost:3000');
      await client.sendIlpPacket({
        destination: 'g.test',
        amount: '0',
        data: '',
        timeout: 5000,
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.timeout).toBe(5000);
    });

    it('should strip trailing slash from baseUrl', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(createFetchResponse({ accepted: true }));
      vi.stubGlobal('fetch', mockFetch);

      const client = createHttpRuntimeClient('http://localhost:3000/');
      await client.sendIlpPacket({
        destination: 'g.test',
        amount: '0',
        data: '',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/admin/ilp/send',
        expect.any(Object)
      );
    });
  });
});

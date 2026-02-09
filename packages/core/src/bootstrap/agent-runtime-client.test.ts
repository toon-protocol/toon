/**
 * Tests for AgentRuntimeClient
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAgentRuntimeClient } from './agent-runtime-client.js';
import { BootstrapError } from './BootstrapService.js';

describe('createAgentRuntimeClient', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('should throw BootstrapError for invalid baseUrl', () => {
    expect(() => createAgentRuntimeClient('not-a-url')).toThrow(BootstrapError);
    expect(() => createAgentRuntimeClient('')).toThrow(BootstrapError);
  });

  it('should create client for valid baseUrl', () => {
    const client = createAgentRuntimeClient('http://localhost:3000');
    expect(client).toBeDefined();
    expect(client.sendIlpPacket).toBeInstanceOf(Function);
  });

  describe('sendIlpPacket', () => {
    it('should return FULFILL result on successful response', async () => {
      const mockResponse = {
        accepted: true,
        fulfillment: 'abc123',
        data: 'base64data',
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      const client = createAgentRuntimeClient('http://localhost:3000');
      const result = await client.sendIlpPacket({
        destination: 'g.peer1',
        amount: '0',
        data: 'dGVzdA==',
      });

      expect(result).toEqual(mockResponse);
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3000/ilp/send',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
      );

      // Verify the body was correct
      const callArgs = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body).toEqual({
        destination: 'g.peer1',
        amount: '0',
        data: 'dGVzdA==',
      });
    });

    it('should return REJECT result with code and message', async () => {
      const mockResponse = {
        accepted: false,
        code: 'F06',
        message: 'Insufficient amount',
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });

      const client = createAgentRuntimeClient('http://localhost:3000');
      const result = await client.sendIlpPacket({
        destination: 'g.peer1',
        amount: '0',
        data: 'dGVzdA==',
      });

      expect(result.accepted).toBe(false);
      expect(result.code).toBe('F06');
      expect(result.message).toBe('Insufficient amount');
    });

    it('should throw BootstrapError on HTTP error (500)', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      const client = createAgentRuntimeClient('http://localhost:3000');

      await expect(
        client.sendIlpPacket({
          destination: 'g.peer1',
          amount: '0',
          data: 'dGVzdA==',
        })
      ).rejects.toThrow(BootstrapError);

      await expect(
        client.sendIlpPacket({
          destination: 'g.peer1',
          amount: '0',
          data: 'dGVzdA==',
        })
      ).rejects.toThrow(/Agent-runtime error \(500\)/);
    });

    it('should throw BootstrapError on network error', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));

      const client = createAgentRuntimeClient('http://localhost:3000');

      await expect(
        client.sendIlpPacket({
          destination: 'g.peer1',
          amount: '0',
          data: 'dGVzdA==',
        })
      ).rejects.toThrow(BootstrapError);

      await expect(
        client.sendIlpPacket({
          destination: 'g.peer1',
          amount: '0',
          data: 'dGVzdA==',
        })
      ).rejects.toThrow(/Network error/);
    });

    it('should include timeout in request body when provided', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ accepted: true }),
      });

      const client = createAgentRuntimeClient('http://localhost:3000');
      await client.sendIlpPacket({
        destination: 'g.peer1',
        amount: '0',
        data: 'dGVzdA==',
        timeout: 30000,
      });

      const callArgs = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body.timeout).toBe(30000);
    });
  });
});

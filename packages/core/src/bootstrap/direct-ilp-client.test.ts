/**
 * Tests for createDirectIlpClient (direct / in-process ILP client).
 */

import { describe, it, expect, vi } from 'vitest';
import { createDirectIlpClient } from './direct-ilp-client.js';
import type {
  ConnectorNodeLike,
  SendPacketParams,
  SendPacketResult,
} from './direct-runtime-client.js';
import { BootstrapError } from './BootstrapService.js';

/** Helper: build a mock ConnectorNodeLike */
function mockConnector(
  result?: SendPacketResult,
  error?: Error
): ConnectorNodeLike {
  const sendPacket = error
    ? vi.fn().mockRejectedValue(error)
    : vi.fn().mockResolvedValue(result);
  return { sendPacket };
}

describe('createDirectIlpClient', () => {
  it('should create a client with sendIlpPacket function', () => {
    const connector = mockConnector({
      type: 'fulfill',
    });
    const client = createDirectIlpClient(connector);
    expect(client).toBeDefined();
    expect(client.sendIlpPacket).toBeInstanceOf(Function);
  });

  describe('sendIlpPacket', () => {
    it('should convert string amount to BigInt correctly', async () => {
      const connector = mockConnector({
        type: 'fulfill',
      });

      const client = createDirectIlpClient(connector);
      await client.sendIlpPacket({
        destination: 'g.peer1',
        amount: '50000',
        data: Buffer.from('test').toString('base64'),
      });

      expect(connector.sendPacket).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 50000n })
      );
    });

    it('should convert base64 data to Uint8Array correctly', async () => {
      const connector = mockConnector({
        type: 'fulfill',
      });

      const testData = Buffer.from('hello world');
      const base64Data = testData.toString('base64');

      const client = createDirectIlpClient(connector);
      await client.sendIlpPacket({
        destination: 'g.peer1',
        amount: '100',
        data: base64Data,
      });

      const callArgs = (connector.sendPacket as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as SendPacketParams;
      expect(Buffer.from(callArgs.data).toString()).toBe('hello world');
    });

    it('should pass destination through unchanged', async () => {
      const connector = mockConnector({
        type: 'fulfill',
      });

      const client = createDirectIlpClient(connector);
      await client.sendIlpPacket({
        destination: 'g.hub.alice',
        amount: '0',
        data: Buffer.from('test').toString('base64'),
      });

      expect(connector.sendPacket).toHaveBeenCalledWith(
        expect.objectContaining({ destination: 'g.hub.alice' })
      );
    });

    it('should map fulfill response to { accepted: true }', async () => {
      const connector = mockConnector({
        type: 'fulfill',
      });

      const client = createDirectIlpClient(connector);
      const result = await client.sendIlpPacket({
        destination: 'g.peer1',
        amount: '100',
        data: Buffer.from('test').toString('base64'),
      });

      expect(result.accepted).toBe(true);
    });

    it('should map reject response to { accepted: false, code, message }', async () => {
      const connector = mockConnector({
        type: 'reject',
        code: 'F06',
        message: 'Insufficient amount',
      });

      const client = createDirectIlpClient(connector);
      const result = await client.sendIlpPacket({
        destination: 'g.peer1',
        amount: '0',
        data: Buffer.from('test').toString('base64'),
      });

      expect(result.accepted).toBe(false);
      expect(result.code).toBe('F06');
      expect(result.message).toBe('Insufficient amount');
    });

    it('should include base64-encoded response data when present in fulfill', async () => {
      const responseData = Buffer.from('response-payload');
      const connector = mockConnector({
        type: 'fulfill',

        data: responseData,
      });

      const client = createDirectIlpClient(connector);
      const result = await client.sendIlpPacket({
        destination: 'g.peer1',
        amount: '100',
        data: Buffer.from('test').toString('base64'),
      });

      expect(result.accepted).toBe(true);
      expect(result.data).toBe(responseData.toString('base64'));
    });

    it('should include base64-encoded response data when present in reject', async () => {
      const responseData = Buffer.from('error-details');
      const connector = mockConnector({
        type: 'reject',
        code: 'T00',
        message: 'Internal error',
        data: responseData,
      });

      const client = createDirectIlpClient(connector);
      const result = await client.sendIlpPacket({
        destination: 'g.peer1',
        amount: '0',
        data: Buffer.from('test').toString('base64'),
      });

      expect(result.accepted).toBe(false);
      expect(result.data).toBe(responseData.toString('base64'));
    });

    it('should omit response data field when not present in fulfill result', async () => {
      const connector = mockConnector({
        type: 'fulfill',
      });

      const client = createDirectIlpClient(connector);
      const result = await client.sendIlpPacket({
        destination: 'g.peer1',
        amount: '100',
        data: Buffer.from('test').toString('base64'),
      });

      expect(result.data).toBeUndefined();
    });

    it('should omit response data field when not present in reject result', async () => {
      const connector = mockConnector({
        type: 'reject',
        code: 'F06',
        message: 'Insufficient',
      });

      const client = createDirectIlpClient(connector);
      const result = await client.sendIlpPacket({
        destination: 'g.peer1',
        amount: '0',
        data: Buffer.from('test').toString('base64'),
      });

      expect(result.data).toBeUndefined();
    });

    it('should wrap sendPacket errors in BootstrapError', async () => {
      const connector = mockConnector(
        undefined,
        new Error('Connector crashed')
      );

      const client = createDirectIlpClient(connector);

      await expect(
        client.sendIlpPacket({
          destination: 'g.peer1',
          amount: '100',
          data: Buffer.from('test').toString('base64'),
        })
      ).rejects.toThrow(BootstrapError);

      await expect(
        client.sendIlpPacket({
          destination: 'g.peer1',
          amount: '100',
          data: Buffer.from('test').toString('base64'),
        })
      ).rejects.toThrow(/Direct ILP packet send failed.*Connector crashed/);
    });

    it('should wrap invalid amount string BigInt parse error in BootstrapError', async () => {
      const connector = mockConnector({
        type: 'fulfill',
      });

      const client = createDirectIlpClient(connector);

      await expect(
        client.sendIlpPacket({
          destination: 'g.peer1',
          amount: 'abc',
          data: Buffer.from('test').toString('base64'),
        })
      ).rejects.toThrow(BootstrapError);
    });

    it('should not pass executionCondition to connector', async () => {
      const toonData = Buffer.from('test-toon-data');

      const connector = mockConnector({
        type: 'fulfill',
      });

      const client = createDirectIlpClient(connector);
      await client.sendIlpPacket({
        destination: 'g.peer1',
        amount: '100',
        data: toonData.toString('base64'),
      });

      const callArgs = (connector.sendPacket as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as SendPacketParams;
      expect(callArgs).not.toHaveProperty('executionCondition');
    });
  });
});

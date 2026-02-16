/**
 * Tests for createDirectRuntimeClient (direct / in-process ILP client).
 */

import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { createDirectRuntimeClient } from './direct-runtime-client.js';
import type { ConnectorNodeLike, SendPacketParams, SendPacketResult } from './direct-runtime-client.js';
import { BootstrapError } from './BootstrapService.js';

/** Helper: build a mock ConnectorNodeLike */
function mockConnector(
  result?: SendPacketResult,
  error?: Error,
): ConnectorNodeLike {
  const sendPacket = error
    ? vi.fn().mockRejectedValue(error)
    : vi.fn().mockResolvedValue(result);
  return { sendPacket };
}

describe('createDirectRuntimeClient', () => {
  it('should create a client with sendIlpPacket function', () => {
    const connector = mockConnector({
      type: 'fulfill',
      fulfillment: new Uint8Array(32),
    });
    const client = createDirectRuntimeClient(connector);
    expect(client).toBeDefined();
    expect(client.sendIlpPacket).toBeInstanceOf(Function);
  });

  describe('sendIlpPacket', () => {
    it('should convert string amount to BigInt correctly', async () => {
      const connector = mockConnector({
        type: 'fulfill',
        fulfillment: new Uint8Array(32),
      });

      const client = createDirectRuntimeClient(connector);
      await client.sendIlpPacket({
        destination: 'g.peer1',
        amount: '50000',
        data: Buffer.from('test').toString('base64'),
      });

      expect(connector.sendPacket).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 50000n }),
      );
    });

    it('should convert base64 data to Uint8Array correctly', async () => {
      const connector = mockConnector({
        type: 'fulfill',
        fulfillment: new Uint8Array(32),
      });

      const testData = Buffer.from('hello world');
      const base64Data = testData.toString('base64');

      const client = createDirectRuntimeClient(connector);
      await client.sendIlpPacket({
        destination: 'g.peer1',
        amount: '100',
        data: base64Data,
      });

      const callArgs = (connector.sendPacket as ReturnType<typeof vi.fn>).mock.calls[0]![0] as SendPacketParams;
      expect(Buffer.from(callArgs.data).toString()).toBe('hello world');
    });

    it('should pass destination through unchanged', async () => {
      const connector = mockConnector({
        type: 'fulfill',
        fulfillment: new Uint8Array(32),
      });

      const client = createDirectRuntimeClient(connector);
      await client.sendIlpPacket({
        destination: 'g.hub.alice',
        amount: '0',
        data: Buffer.from('test').toString('base64'),
      });

      expect(connector.sendPacket).toHaveBeenCalledWith(
        expect.objectContaining({ destination: 'g.hub.alice' }),
      );
    });

    it('should map fulfill response to { accepted: true, fulfillment }', async () => {
      const fulfillmentBytes = createHash('sha256').update('test-id').digest();
      const connector = mockConnector({
        type: 'fulfill',
        fulfillment: fulfillmentBytes,
      });

      const client = createDirectRuntimeClient(connector);
      const result = await client.sendIlpPacket({
        destination: 'g.peer1',
        amount: '100',
        data: Buffer.from('test').toString('base64'),
      });

      expect(result.accepted).toBe(true);
      expect(result.fulfillment).toBe(
        Buffer.from(fulfillmentBytes).toString('base64'),
      );
    });

    it('should map reject response to { accepted: false, code, message }', async () => {
      const connector = mockConnector({
        type: 'reject',
        code: 'F06',
        message: 'Insufficient amount',
      });

      const client = createDirectRuntimeClient(connector);
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
        fulfillment: new Uint8Array(32),
        data: responseData,
      });

      const client = createDirectRuntimeClient(connector);
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

      const client = createDirectRuntimeClient(connector);
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
        fulfillment: new Uint8Array(32),
      });

      const client = createDirectRuntimeClient(connector);
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

      const client = createDirectRuntimeClient(connector);
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
        new Error('Connector crashed'),
      );

      const client = createDirectRuntimeClient(connector);

      await expect(
        client.sendIlpPacket({
          destination: 'g.peer1',
          amount: '100',
          data: Buffer.from('test').toString('base64'),
        }),
      ).rejects.toThrow(BootstrapError);

      await expect(
        client.sendIlpPacket({
          destination: 'g.peer1',
          amount: '100',
          data: Buffer.from('test').toString('base64'),
        }),
      ).rejects.toThrow(/Direct ILP packet send failed.*Connector crashed/);
    });

    it('should wrap invalid amount string BigInt parse error in BootstrapError', async () => {
      const connector = mockConnector({
        type: 'fulfill',
        fulfillment: new Uint8Array(32),
      });

      const client = createDirectRuntimeClient(connector);

      await expect(
        client.sendIlpPacket({
          destination: 'g.peer1',
          amount: 'abc',
          data: Buffer.from('test').toString('base64'),
        }),
      ).rejects.toThrow(BootstrapError);
    });

    describe('executionCondition with toonDecoder', () => {
      it('should compute executionCondition = SHA256(SHA256(eventId)) when toonDecoder is provided', async () => {
        const eventId = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

        const toonDecoder = vi.fn().mockReturnValue({ id: eventId });

        const connector = mockConnector({
          type: 'fulfill',
          fulfillment: new Uint8Array(32),
        });

        const client = createDirectRuntimeClient(connector, { toonDecoder });
        await client.sendIlpPacket({
          destination: 'g.peer1',
          amount: '100',
          data: Buffer.from('test-toon-data').toString('base64'),
        });

        // Compute expected condition
        const fulfillment = createHash('sha256').update(eventId).digest();
        const expectedCondition = createHash('sha256')
          .update(fulfillment)
          .digest();

        const callArgs = (connector.sendPacket as ReturnType<typeof vi.fn>).mock.calls[0]![0] as SendPacketParams;
        expect(Buffer.from(callArgs.executionCondition!)).toEqual(
          Buffer.from(expectedCondition),
        );
      });

      it('should not set executionCondition when toonDecoder is omitted', async () => {
        const connector = mockConnector({
          type: 'fulfill',
          fulfillment: new Uint8Array(32),
        });

        const client = createDirectRuntimeClient(connector);
        await client.sendIlpPacket({
          destination: 'g.peer1',
          amount: '100',
          data: Buffer.from('test').toString('base64'),
        });

        const callArgs = (connector.sendPacket as ReturnType<typeof vi.fn>).mock.calls[0]![0] as SendPacketParams;
        expect(callArgs.executionCondition).toBeUndefined();
      });

      it('should handle toonDecoder throwing gracefully (wraps in BootstrapError)', async () => {
        const toonDecoder = vi.fn().mockImplementation(() => {
          throw new Error('Invalid TOON format');
        });

        const connector = mockConnector({
          type: 'fulfill',
          fulfillment: new Uint8Array(32),
        });

        const client = createDirectRuntimeClient(connector, { toonDecoder });

        await expect(
          client.sendIlpPacket({
            destination: 'g.peer1',
            amount: '100',
            data: Buffer.from('bad-data').toString('base64'),
          }),
        ).rejects.toThrow(BootstrapError);

        await expect(
          client.sendIlpPacket({
            destination: 'g.peer1',
            amount: '100',
            data: Buffer.from('bad-data').toString('base64'),
          }),
        ).rejects.toThrow(/Direct ILP packet send failed.*Invalid TOON format/);
      });
    });
  });
});

import { describe, it, expect } from 'vitest';
import type {
  IlpPeerInfo,
  SpspInfo,
  SpspRequest,
  SpspResponse,
} from './types.js';

describe('TypeScript Interfaces', () => {
  describe('IlpPeerInfo', () => {
    it('should allow creating a valid IlpPeerInfo object', () => {
      const peerInfo: IlpPeerInfo = {
        ilpAddress: 'g.example.connector',
        btpEndpoint: 'wss://example.com/btp',
        assetCode: 'USD',
        assetScale: 6,
      };

      expect(peerInfo.ilpAddress).toBe('g.example.connector');
      expect(peerInfo.btpEndpoint).toBe('wss://example.com/btp');
      expect(peerInfo.assetCode).toBe('USD');
      expect(peerInfo.assetScale).toBe(6);
    });

    it('should allow optional settlementEngine field', () => {
      const peerInfoWithSettlement: IlpPeerInfo = {
        ilpAddress: 'g.example.connector',
        btpEndpoint: 'wss://example.com/btp',
        settlementEngine: 'xrp-paychan',
        assetCode: 'XRP',
        assetScale: 9,
      };

      expect(peerInfoWithSettlement.settlementEngine).toBe('xrp-paychan');
    });
  });

  describe('SpspInfo', () => {
    it('should allow creating a valid SpspInfo object', () => {
      const spspInfo: SpspInfo = {
        destinationAccount: 'g.example.user123',
        sharedSecret: 'c2VjcmV0MTIz',
      };

      expect(spspInfo.destinationAccount).toBe('g.example.user123');
      expect(spspInfo.sharedSecret).toBe('c2VjcmV0MTIz');
    });
  });

  describe('SpspRequest', () => {
    it('should allow creating a valid SpspRequest object', () => {
      const request: SpspRequest = {
        requestId: 'req-abc-123',
        timestamp: 1700000000,
      };

      expect(request.requestId).toBe('req-abc-123');
      expect(request.timestamp).toBe(1700000000);
    });
  });

  describe('SpspResponse', () => {
    it('should allow creating a valid SpspResponse object', () => {
      const response: SpspResponse = {
        requestId: 'req-abc-123',
        destinationAccount: 'g.example.user123',
        sharedSecret: 'c2VjcmV0MTIz',
      };

      expect(response.requestId).toBe('req-abc-123');
      expect(response.destinationAccount).toBe('g.example.user123');
      expect(response.sharedSecret).toBe('c2VjcmV0MTIz');
    });
  });
});

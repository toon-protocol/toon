import { describe, it, expect } from 'vitest';
import type { IlpPeerInfo } from './types.js';

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
});

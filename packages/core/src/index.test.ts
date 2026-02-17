import { describe, it, expect } from 'vitest';
import {
  VERSION,
  ILP_PEER_INFO_KIND,
  SPSP_REQUEST_KIND,
  SPSP_RESPONSE_KIND,
} from './index.js';
import type {
  IlpPeerInfo,
  SpspInfo,
  SpspRequest,
  SpspResponse,
} from './index.js';

describe('@crosstown/core', () => {
  it('should export VERSION', () => {
    expect(VERSION).toBe('0.1.0');
  });

  describe('exports event kind constants', () => {
    it('should export ILP_PEER_INFO_KIND', () => {
      expect(ILP_PEER_INFO_KIND).toBe(10032);
    });

    it('should export SPSP_REQUEST_KIND', () => {
      expect(SPSP_REQUEST_KIND).toBe(23194);
    });

    it('should export SPSP_RESPONSE_KIND', () => {
      expect(SPSP_RESPONSE_KIND).toBe(23195);
    });
  });

  describe('exports TypeScript interfaces', () => {
    it('should export IlpPeerInfo type', () => {
      const peerInfo: IlpPeerInfo = {
        ilpAddress: 'g.test',
        btpEndpoint: 'wss://test.com',
        assetCode: 'USD',
        assetScale: 6,
      };
      expect(peerInfo).toBeDefined();
    });

    it('should export SpspInfo type', () => {
      const spspInfo: SpspInfo = {
        destinationAccount: 'g.test.user',
        sharedSecret: 'dGVzdA==',
      };
      expect(spspInfo).toBeDefined();
    });

    it('should export SpspRequest type', () => {
      const request: SpspRequest = {
        requestId: 'test-123',
        timestamp: Date.now(),
      };
      expect(request).toBeDefined();
    });

    it('should export SpspResponse type', () => {
      const response: SpspResponse = {
        requestId: 'test-123',
        destinationAccount: 'g.test.user',
        sharedSecret: 'dGVzdA==',
      };
      expect(response).toBeDefined();
    });
  });
});

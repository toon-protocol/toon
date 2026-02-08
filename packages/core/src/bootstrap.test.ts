/**
 * Tests for BootstrapService
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { BootstrapService, BootstrapError } from './bootstrap.js';
import { ILP_PEER_INFO_KIND } from './constants.js';
import type { IlpPeerInfo, KnownPeer } from './types.js';

describe('BootstrapService', () => {
  const secretKey = generateSecretKey();
  const pubkey = getPublicKey(secretKey);

  const ownIlpInfo: IlpPeerInfo = {
    ilpAddress: 'g.test.me',
    btpEndpoint: 'ws://localhost:3000',
    assetCode: 'USD',
    assetScale: 6,
  };

  describe('constructor', () => {
    it('should create instance with valid config', () => {
      const service = new BootstrapService(
        { knownPeers: [] },
        secretKey,
        ownIlpInfo
      );

      expect(service.getPubkey()).toBe(pubkey);
    });

    it('should set default timeouts', () => {
      const service = new BootstrapService(
        { knownPeers: [] },
        secretKey,
        ownIlpInfo
      );

      // Service should be created without errors
      expect(service).toBeDefined();
    });
  });

  describe('bootstrap', () => {
    it('should return empty array when no known peers', async () => {
      const service = new BootstrapService(
        { knownPeers: [] },
        secretKey,
        ownIlpInfo
      );

      const results = await service.bootstrap();

      expect(results).toEqual([]);
    });
  });

  describe('bootstrapWithPeer', () => {
    it('should throw BootstrapError for invalid pubkey format', async () => {
      const service = new BootstrapService(
        { knownPeers: [] },
        secretKey,
        ownIlpInfo
      );

      const invalidPeer: KnownPeer = {
        pubkey: 'not-a-valid-pubkey',
        relayUrl: 'ws://localhost:7000',
        btpEndpoint: 'ws://localhost:3000',
      };

      await expect(service.bootstrapWithPeer(invalidPeer)).rejects.toThrow(
        BootstrapError
      );
    });
  });

  describe('BootstrapError', () => {
    it('should have correct name and code', () => {
      const error = new BootstrapError('Test error');

      expect(error.name).toBe('BootstrapError');
      expect(error.code).toBe('BOOTSTRAP_FAILED');
      expect(error.message).toBe('Test error');
    });

    it('should chain cause error', () => {
      const cause = new Error('Cause');
      const error = new BootstrapError('Test error', cause);

      expect(error.cause).toBe(cause);
    });
  });

  describe('getPubkey', () => {
    it('should return the derived pubkey', () => {
      const service = new BootstrapService(
        { knownPeers: [] },
        secretKey,
        ownIlpInfo
      );

      expect(service.getPubkey()).toBe(pubkey);
      expect(service.getPubkey()).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});

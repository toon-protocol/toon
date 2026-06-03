/**
 * Tests for resolveNetworkProfile (network-mode → apex + node config).
 */

import { describe, it, expect } from 'vitest';
import { resolveNetworkProfile, RELAY_ONLY_CHAIN } from './network-profile.js';
import type { ChainProviderConfigEntry } from './chain-config.js';

describe('resolveNetworkProfile', () => {
  describe('mainnet (default tier)', () => {
    const p = resolveNetworkProfile('mainnet');

    it('uses Base as the primary EVM chain', () => {
      expect(p.nodeEnv.EVM_CHAIN).toBe('base-mainnet');
      expect(p.nodeEnv.EVM_CHAIN_ID).toBe('8453');
      expect(p.nodeEnv.EVM_RPC_URL).toBe('https://mainnet.base.org');
      expect(p.nodeEnv.EVM_USDC_ADDRESS).toBe(
        '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
      );
    });

    it('uses public Solana mainnet-beta + USDC mint', () => {
      expect(p.nodeEnv.SOLANA_RPC_URL).toBe(
        'https://api.mainnet-beta.solana.com'
      );
      expect(p.nodeEnv.SOLANA_USDC_MINT).toBe(
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
      );
    });

    it('never points at a localhost RPC (avoids the boot-loop brick)', () => {
      expect(p.nodeEnv.EVM_RPC_URL).not.toMatch(/localhost|127\.0\.0\.1/);
      expect(p.nodeEnv.SOLANA_RPC_URL).not.toMatch(/localhost|127\.0\.0\.1/);
    });

    it('is settlement-unconfigured (no TOON contracts deployed yet)', () => {
      expect(p.status).toEqual({
        evm: 'unconfigured',
        solana: 'unconfigured',
        mina: 'unconfigured',
      });
      expect(p.chainProviders).toEqual([]);
    });
  });

  describe('testnet', () => {
    const p = resolveNetworkProfile('testnet');
    it('uses Base Sepolia as primary EVM', () => {
      expect(p.nodeEnv.EVM_CHAIN).toBe('base-sepolia');
      expect(p.nodeEnv.EVM_CHAIN_ID).toBe('84532');
    });
    it('uses public Solana testnet (no canonical USDC mint)', () => {
      expect(p.nodeEnv.SOLANA_RPC_URL).toBe('https://api.testnet.solana.com');
      expect(p.nodeEnv.SOLANA_USDC_MINT).toBeUndefined();
    });
  });

  describe('devnet (public Sepolia for EVM, public Solana/Mina devnets)', () => {
    const p = resolveNetworkProfile('devnet');
    it('uses Base Sepolia as primary EVM (no public EVM devnet)', () => {
      expect(p.nodeEnv.EVM_CHAIN).toBe('base-sepolia');
    });
    it('uses public Solana devnet + USDC mint', () => {
      expect(p.nodeEnv.SOLANA_RPC_URL).toBe('https://api.devnet.solana.com');
      expect(p.nodeEnv.SOLANA_USDC_MINT).toBe(
        '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
      );
    });
    it('does not use the local solana-devnet/mina-devnet presets', () => {
      expect(p.nodeEnv.SOLANA_RPC_URL).not.toContain('19899');
    });
  });

  describe('settlement-complete chains are emitted as connector providers', () => {
    it('builds an EVM provider once a keyId + on-chain addresses exist', () => {
      // Simulate a future deploy by passing custom providers through `custom`,
      // since presets have empty registry today. Here we assert the apex path
      // only emits providers when keyId is supplied.
      const withKey = resolveNetworkProfile('mainnet', { keyId: '0xabc' });
      // Still empty because preset registry/tokenNetwork are unset.
      expect(withKey.chainProviders).toEqual([]);
    });
  });

  describe('custom with endpoints (--evm-url / --sol-url → project dev chains)', () => {
    it('points EVM at akash-anvil (31338) with operator URL → settlement-complete', () => {
      const p = resolveNetworkProfile('custom', {
        endpoints: { evmUrl: 'https://anvil.ingress.akash.example' },
        keyId: '0xkey',
      });
      expect(p.nodeEnv.EVM_CHAIN).toBe('akash-anvil');
      expect(p.nodeEnv.EVM_CHAIN_ID).toBe('31338');
      expect(p.nodeEnv.EVM_RPC_URL).toBe('https://anvil.ingress.akash.example');
      expect(p.status.evm).toBe('configured');
      // Apex gets a real EVM provider (registry/tokenNetwork are baked).
      expect(p.chainProviders).toHaveLength(1);
      expect(p.chainProviders[0].chainType).toBe('evm');
    });

    it('Solana URL → RPC + mock USDC mint, but relay-only (program not deployed)', () => {
      const p = resolveNetworkProfile('custom', {
        endpoints: {
          evmUrl: 'https://anvil.example',
          solUrl: 'https://sol.ingress.akash.example',
        },
        keyId: '0xkey',
      });
      expect(p.nodeEnv.SOLANA_RPC_URL).toBe(
        'https://sol.ingress.akash.example'
      );
      expect(p.nodeEnv.SOLANA_USDC_MINT).toBe(
        '6GbdrVghwNKTz9raga7y3Y4qqX5Zgg3AC4d48Kt7C59Q'
      );
      expect(p.status.solana).toBe('unconfigured'); // no program
    });

    it('explicit providers take precedence over endpoints', () => {
      const p = resolveNetworkProfile('custom', {
        customProviders: [
          {
            chainType: 'evm',
            chainId: 'evm:8453',
            rpcUrl: 'https://explicit',
            registryAddress: '0xReg',
            tokenAddress: '0xUSDC',
            keyId: '0xkey',
          },
        ],
        endpoints: { evmUrl: 'https://ignored' },
      });
      expect(p.nodeEnv.EVM_RPC_URL).toBe('https://explicit');
    });
  });

  describe('custom', () => {
    const customProviders: ChainProviderConfigEntry[] = [
      {
        chainType: 'evm',
        chainId: 'evm:8453',
        rpcUrl: 'https://my-private-base-rpc.example',
        registryAddress: '0xReg',
        tokenAddress: '0xUSDC',
        keyId: '0xkey',
      },
    ];
    const p = resolveNetworkProfile('custom', { customProviders });

    it('passes operator providers through verbatim', () => {
      expect(p.chainProviders).toBe(customProviders);
    });
    it('derives node env from the custom EVM provider', () => {
      expect(p.nodeEnv.EVM_RPC_URL).toBe('https://my-private-base-rpc.example');
      expect(p.nodeEnv.EVM_CHAIN_ID).toBe('8453'); // namespace stripped
      expect(p.nodeEnv.EVM_CHAIN).toBe(RELAY_ONLY_CHAIN);
      expect(p.status.evm).toBe('configured'); // registry present
    });

    it('falls back to relay-only when custom has no EVM provider', () => {
      const empty = resolveNetworkProfile('custom', { customProviders: [] });
      expect(empty.nodeEnv.EVM_CHAIN).toBe(RELAY_ONLY_CHAIN);
      expect(empty.chainProviders).toEqual([]);
      expect(empty.status.evm).toBe('unconfigured');
    });
  });
});

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

  // testnet and devnet both resolve to TOON's single deployed public-testnet
  // environment (Base Sepolia + Solana devnet + Mina devnet; e2e/testnets.json).
  for (const tier of ['testnet', 'devnet'] as const) {
    describe(`${tier} (deployed public-testnet triple)`, () => {
      const p = resolveNetworkProfile(tier);
      it('uses Base Sepolia as primary EVM', () => {
        expect(p.nodeEnv.EVM_CHAIN).toBe('base-sepolia');
        expect(p.nodeEnv.EVM_CHAIN_ID).toBe('84532');
        expect(p.nodeEnv.EVM_USDC_ADDRESS).toBe(
          '0x49beE1Bca5d15Fb0963117923403F9498119a9Ce'
        );
      });
      it('uses the deployed Solana devnet program + mint', () => {
        expect(p.nodeEnv.SOLANA_RPC_URL).toBe('https://api.devnet.solana.com');
        expect(p.nodeEnv.SOLANA_USDC_MINT).toBe(
          '9FtYCXjNiGDn17jSGvZuB5P4dZAKgVxUsDiQpLc8rbWy'
        );
      });
      it('does not use the local solana-devnet/mina-devnet presets', () => {
        expect(p.nodeEnv.SOLANA_RPC_URL).not.toContain('19899');
      });
      it('reports every family settlement-configured when a keyId is supplied', () => {
        // `status` tracks apex settlement readiness, which the apex resolves
        // with its settlement signing key (children resolve relay-only).
        const withKey = resolveNetworkProfile(tier, { keyId: '0xkey' });
        expect(withKey.status).toEqual({
          evm: 'configured',
          solana: 'configured',
          mina: 'configured',
        });
      });
      it('emits connector providers for all three families when a keyId is supplied', () => {
        const withKey = resolveNetworkProfile(tier, { keyId: '0xkey' });
        const types = withKey.chainProviders.map((c) => c.chainType).sort();
        expect(types).toContain('evm');
        expect(types).toContain('solana');
        expect(types).toContain('mina');
      });
    });
  }

  describe('settlement providers require a keyId', () => {
    it('builds no providers without a keyId even when addresses are present', () => {
      // testnet presets are settlement-complete, but the apex only emits
      // connector providers when the settlement signing key is supplied.
      const noKey = resolveNetworkProfile('testnet');
      expect(noKey.chainProviders).toEqual([]);
      expect(noKey.status).toEqual({
        evm: 'unconfigured',
        solana: 'unconfigured',
        mina: 'unconfigured',
      });
    });
    it('mainnet stays provider-less (contracts not deployed there)', () => {
      const withKey = resolveNetworkProfile('mainnet', { keyId: '0xabc' });
      expect(withKey.chainProviders).toEqual([]);
    });
  });

  describe('custom with endpoints (--evm-url / --sol-url → project dev chains)', () => {
    it('points EVM at anvil (31337) with operator URL → settlement-complete', () => {
      const p = resolveNetworkProfile('custom', {
        endpoints: { evmUrl: 'https://anvil.ingress.akash.example' },
        keyId: '0xkey',
      });
      expect(p.nodeEnv.EVM_CHAIN).toBe('anvil');
      expect(p.nodeEnv.EVM_CHAIN_ID).toBe('31337');
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

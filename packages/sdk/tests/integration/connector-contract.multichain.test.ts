/**
 * Connector Contract Canary — Solana + Mina claim/balance-proof envelopes.
 *
 * Per-PR companion to `connector-contract.test.ts` (which is EVM-shaped). The
 * EVM claim path already has per-PR contract coverage; Solana/Mina were only
 * exercised by the nightly Docker E2E matrix. This canary closes that gap: it
 * asserts the NON-EVM off-chain balance-proof envelope SHAPES the connector's
 * settlement path consumes, and round-trips sign -> verify against the SDK's OWN
 * verifiers so signer<->verifier drift on the Solana/Mina paths fails on EVERY
 * pull request.
 *
 * Coverage:
 *   - Solana: build an `AccumulatedClaim` balance-proof envelope, sign the
 *     shared `balanceProofHashSolana` message with Ed25519 (deterministic test
 *     key), assert the envelope shape (chain discriminator `solana`, 64-byte
 *     Ed25519 signature in `claimBytes`, channelId/cumulativeAmount/nonce/
 *     recipient present) and round-trip it through `verifyEd25519Signature`.
 *     Then assert `buildSolanaSettlementTx` emits a `SettlementBundle` with
 *     `chainKind: 'solana'` and the connector-consumed metadata.
 *   - Mina: build the Mill-format claim envelope by signing the shared
 *     `balanceProofFieldsMina` field-element message with `mina-signer`
 *     (`signFields`), assert the envelope shape (chain discriminator `mina`,
 *     base58 signature string as UTF-8 `claimBytes`), round-trip through
 *     `verifyMinaSignature`, and assert `buildMinaSettlementTx` emits a
 *     `SettlementBundle` with `chainKind: 'mina'`.
 *
 * PURE: no Docker, no RPC, no chain. Signing + shape + local verify are all
 * offline. The Solana path uses `@noble/curves` Ed25519 (an SDK dep). The Mina
 * path uses `mina-signer`'s CHEAP `signFields`/`verifyFields` — it does NOT and
 * MUST NOT trigger an o1js / @toon-protocol/mina-zkapp circuit COMPILE. The
 * on-chain Mina zkApp `claimFromChannel` proof-generation path (o1js, multi-
 * second, memory-heavy) is intentionally OUT OF SCOPE here and is covered only
 * by the nightly Docker E2E. `mina-signer` is an OPTIONAL peer dep, so the Mina
 * SIGN/VERIFY round-trip is `skipIf`-gated when it is absent (the default in
 * CI, mirroring `src/settlement/mina.test.ts`); the offline-derivable Mina shape
 * assertions that do not need a signer still run unconditionally.
 *
 * If this test fails, see packages/sdk/CONNECTOR_MIGRATION.md for the
 * version-to-version contract mapping.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import type { SwapPair } from '@toon-protocol/core';

import type { AccumulatedClaim } from '../../src/stream-swap.js';
import { base58Encode, balanceProofHashSolana } from '../../src/index.js';
import { balanceProofFieldsMina } from '../../src/settlement/hashes.js';
import {
  verifyEd25519Signature,
  buildSolanaSettlementTx,
} from '../../src/settlement/solana.js';
import {
  verifyMinaSignature,
  buildMinaSettlementTx,
  loadMinaSignerClient,
  type MinaSignerClientLike,
} from '../../src/settlement/mina.js';
import type {
  MillSignerConfig,
  SettlementBundle,
} from '../../src/settlement/types.js';

// 60-second per-test ceiling — mirrors the EVM canary's hard cap. Each test
// finishes in single-digit ms (Ed25519 sign/verify + Pallas signFields); the
// cap exists so a hung optional-dep import fails the canary fast.
const SIXTY_SECONDS = 60_000;

// ---------------------------------------------------------------------------
// Solana — Ed25519 balance-proof claim envelope (offline, no peer dep needed).
// ---------------------------------------------------------------------------

const SOLANA_PAIR: SwapPair = {
  from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:8453' },
  to: { assetCode: 'SOL', assetScale: 9, chain: 'solana:mainnet' },
  rate: '0.001',
};

function fill32(byte: number): Uint8Array {
  const out = new Uint8Array(32);
  out.fill(byte);
  return out;
}

/** Deterministic 32-byte Ed25519 seed -> fixed signer pubkey for round-trips. */
function solanaSigner(): { privateKey: Uint8Array; signerAddress: string } {
  const privateKey = new Uint8Array(32);
  privateKey[0] = 7;
  const pubkey = ed25519.getPublicKey(privateKey);
  return { privateKey, signerAddress: base58Encode(new Uint8Array(pubkey)) };
}

/**
 * Construct a signed Solana balance-proof envelope (`AccumulatedClaim`) the way
 * the connector's settlement path consumes it: a 64-byte Ed25519 signature over
 * `balanceProofHashSolana(channelId, cumulativeAmount, nonce, recipient)`,
 * carried as `claimBytes`.
 */
function signedSolanaClaim(): {
  claim: AccumulatedClaim;
  signerAddress: string;
} {
  const { privateKey, signerAddress } = solanaSigner();
  const channelId = base58Encode(fill32(0x77));
  const recipient = base58Encode(fill32(0x88));
  const cumulativeAmount = '500';
  const nonce = '1';

  const msgHash = balanceProofHashSolana(
    channelId,
    BigInt(cumulativeAmount),
    BigInt(nonce),
    recipient
  );
  const sig = new Uint8Array(ed25519.sign(msgHash, privateKey));

  const claim: AccumulatedClaim = {
    packetIndex: 0,
    sourceAmount: 1_000_000n,
    targetAmount: 500n,
    claimBytes: sig,
    millEphemeralPubkey: '0'.repeat(64),
    pair: SOLANA_PAIR,
    receivedAt: Date.now(),
    channelId,
    nonce,
    cumulativeAmount,
    recipient,
    millSignerAddress: signerAddress,
  };
  return { claim, signerAddress };
}

describe(
  'connector contract (multichain): Solana balance-proof claim envelope',
  { timeout: SIXTY_SECONDS },
  () => {
    it('envelope SHAPE: chain discriminator solana, 64-byte Ed25519 signature, required settlement fields present', () => {
      const { claim } = signedSolanaClaim();

      // Chain discriminator the connector routes settlement by.
      expect(claim.pair.to.chain).toBe('solana:mainnet');
      expect(claim.pair.to.chain.startsWith('solana:')).toBe(true);

      // Signature encoding: raw 64-byte Ed25519 in claimBytes (NOT base64/hex
      // at this layer — the wire claim is the raw signature bytes).
      expect(claim.claimBytes).toBeInstanceOf(Uint8Array);
      expect(claim.claimBytes.length).toBe(64);

      // Settlement metadata the verifier + settler require (channelId/recipient
      // are base58 32-byte addresses; cumulativeAmount/nonce are decimal
      // strings for bigint precision).
      expect(typeof claim.channelId).toBe('string');
      expect(typeof claim.recipient).toBe('string');
      expect(typeof claim.cumulativeAmount).toBe('string');
      expect(typeof claim.nonce).toBe('string');
      expect(typeof claim.millSignerAddress).toBe('string');
    });

    it('round-trip: a freshly-signed envelope verifies via verifyEd25519Signature (signer<->verifier parity)', () => {
      const { claim, signerAddress } = signedSolanaClaim();
      expect(verifyEd25519Signature(claim, signerAddress)).toBe(true);
    });

    it('round-trip: tampering cumulativeAmount/nonce/channelId breaks verification', () => {
      const { claim, signerAddress } = signedSolanaClaim();
      expect(
        verifyEd25519Signature(
          { ...claim, cumulativeAmount: '999' },
          signerAddress
        )
      ).toBe(false);
      expect(
        verifyEd25519Signature({ ...claim, nonce: '2' }, signerAddress)
      ).toBe(false);
      expect(
        verifyEd25519Signature(
          { ...claim, channelId: base58Encode(fill32(0x55)) },
          signerAddress
        )
      ).toBe(false);
    });

    it('buildSolanaSettlementTx emits a SettlementBundle with chainKind:solana + connector-consumed metadata', () => {
      const { claim, signerAddress } = signedSolanaClaim();
      const signer: MillSignerConfig = {
        address: signerAddress,
        programId: base58Encode(fill32(0x66)),
      };
      const bundle: SettlementBundle = buildSolanaSettlementTx(
        claim,
        signer,
        claim.recipient!,
        0,
        1
      );
      expect(bundle.chainKind).toBe('solana');
      expect(bundle.chain).toBe('solana:mainnet');
      expect(bundle.channelId).toBe(claim.channelId);
      expect(bundle.cumulativeAmount).toBe('500');
      expect(bundle.nonce).toBe('1');
      expect(bundle.recipient).toBe(claim.recipient);
      expect(bundle.unsignedTxBytes.length).toBeGreaterThan(0);
    });
  }
);

// ---------------------------------------------------------------------------
// Mina — mina-signer (signFields) balance-proof claim envelope.
//
// CRITICAL: this path uses ONLY mina-signer's cheap signFields/verifyFields. It
// does NOT pull an o1js / mina-zkapp circuit COMPILE. The on-chain zkApp
// claimFromChannel proof path is covered exclusively by the nightly Docker E2E.
//
// `mina-signer` is an OPTIONAL peer dep, absent by default in CI (peer deps are
// not installed). The SIGN/VERIFY round-trip is `skipIf`-gated on its presence,
// mirroring `src/settlement/mina.test.ts`; the offline-derivable shape
// assertions below run unconditionally.
// ---------------------------------------------------------------------------

const MINA_PAIR: SwapPair = {
  from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:8453' },
  to: { assetCode: 'MINA', assetScale: 9, chain: 'mina:mainnet' },
  rate: '0.5',
};

interface MinaSignerFullClient extends MinaSignerClientLike {
  genKeys(): { privateKey: string; publicKey: string };
  signFields(
    fields: bigint[],
    privateKey: string
  ): { signature: string | { field: string; scalar: string } };
}

const initialMinaClient = (await loadMinaSignerClient()) as
  | MinaSignerFullClient
  | undefined;
const hasMinaSigner = initialMinaClient !== undefined;

let minaClient: MinaSignerFullClient;
beforeAll(() => {
  // Non-null inside the skipIf(!hasMinaSigner) block.
  minaClient = initialMinaClient as MinaSignerFullClient;
});

/**
 * Reproduce the Mill's Mina signing path: sign the shared field-element message
 * (`balanceProofFieldsMina`) via `signFields` and emit the base58 signature
 * string as UTF-8 `claimBytes` — the exact wire form a sender receives.
 */
function signedMinaClaim(): {
  claim: AccumulatedClaim;
  signerAddress: string;
} {
  const keys = minaClient.genKeys();
  const channelId = 'B62qChannelExample1111111111111111111111111111';
  const recipient = 'B62qRecipientExample22222222222222222222222222';
  const cumulativeAmount = '500';
  const nonce = '1';

  const fields = balanceProofFieldsMina(
    channelId,
    BigInt(cumulativeAmount),
    BigInt(nonce),
    recipient
  );
  const signed = minaClient.signFields(fields, keys.privateKey);
  const sigStr =
    typeof signed.signature === 'string'
      ? signed.signature
      : JSON.stringify(signed.signature);
  const claimBytes = new TextEncoder().encode(sigStr);

  const claim: AccumulatedClaim = {
    packetIndex: 0,
    sourceAmount: 1_000_000n,
    targetAmount: 500n,
    claimBytes,
    millEphemeralPubkey: '0'.repeat(64),
    pair: MINA_PAIR,
    receivedAt: Date.now(),
    channelId,
    nonce,
    cumulativeAmount,
    recipient,
    millSignerAddress: keys.publicKey,
  };
  return { claim, signerAddress: keys.publicKey };
}

describe(
  'connector contract (multichain): Mina balance-proof claim envelope',
  { timeout: SIXTY_SECONDS },
  () => {
    it('SDK exposes the Mina verifier surface (loadMinaSignerClient + verifyMinaSignature) regardless of peer-dep presence', () => {
      // Contract: these named exports must exist on the SDK's non-EVM claim
      // surface even when the optional `mina-signer` peer dep is absent — a
      // rename/removal fails this canary at import/compile time on every PR.
      expect(typeof loadMinaSignerClient).toBe('function');
      expect(typeof verifyMinaSignature).toBe('function');
      expect(typeof buildMinaSettlementTx).toBe('function');
    });

    it.skipIf(!hasMinaSigner)(
      'envelope SHAPE: chain discriminator mina, base58 signature string as UTF-8 claimBytes, required settlement fields present',
      () => {
        const { claim } = signedMinaClaim();

        expect(claim.pair.to.chain).toBe('mina:mainnet');
        expect(claim.pair.to.chain.startsWith('mina:')).toBe(true);

        // Signature encoding: the Mill emits a base58 mina-signer signature
        // STRING carried as UTF-8 bytes (NOT a fixed-length binary blob).
        expect(claim.claimBytes).toBeInstanceOf(Uint8Array);
        expect(claim.claimBytes.length).toBeGreaterThan(0);
        const sigStr = new TextDecoder().decode(claim.claimBytes);
        // base58 alphabet (Bitcoin/Mina) — no 0OIl.
        expect(/^[1-9A-HJ-NP-Za-km-z]+$/.test(sigStr)).toBe(true);

        expect(typeof claim.channelId).toBe('string');
        expect(typeof claim.recipient).toBe('string');
        expect(typeof claim.cumulativeAmount).toBe('string');
        expect(typeof claim.nonce).toBe('string');
        // Mill signer address is a B62-prefixed Mina public key.
        expect(claim.millSignerAddress?.startsWith('B62')).toBe(true);
      }
    );

    it.skipIf(!hasMinaSigner)(
      'round-trip: a freshly-signed envelope verifies via verifyMinaSignature (signer<->verifier parity)',
      () => {
        const { claim, signerAddress } = signedMinaClaim();
        expect(verifyMinaSignature(claim, signerAddress, minaClient)).toBe(
          true
        );
      }
    );

    it.skipIf(!hasMinaSigner)(
      'round-trip: tampering cumulativeAmount/nonce/channelId breaks verification',
      () => {
        const { claim, signerAddress } = signedMinaClaim();
        expect(
          verifyMinaSignature(
            { ...claim, cumulativeAmount: '999' },
            signerAddress,
            minaClient
          )
        ).toBe(false);
        expect(
          verifyMinaSignature(
            { ...claim, nonce: '2' },
            signerAddress,
            minaClient
          )
        ).toBe(false);
        expect(
          verifyMinaSignature(
            {
              ...claim,
              channelId: 'B62qOtherChannel333333333333333333333333333',
            },
            signerAddress,
            minaClient
          )
        ).toBe(false);
      }
    );

    it.skipIf(!hasMinaSigner)(
      'buildMinaSettlementTx emits a SettlementBundle with chainKind:mina + re-emits the verified proof bytes',
      () => {
        const { claim, signerAddress } = signedMinaClaim();
        const signer: MillSignerConfig = { address: signerAddress };
        const bundle: SettlementBundle = buildMinaSettlementTx(
          claim,
          signer,
          claim.recipient!,
          0,
          1
        );
        expect(bundle.chainKind).toBe('mina');
        expect(bundle.chain).toBe('mina:mainnet');
        expect(bundle.channelId).toBe(claim.channelId);
        expect(bundle.cumulativeAmount).toBe('500');
        expect(bundle.nonce).toBe('1');
        expect(bundle.recipient).toBe(claim.recipient);
        expect(bundle.millSignerAddress).toBe(signerAddress);
        // Envelope re-emits the verified balance-proof signature verbatim.
        expect(bundle.unsignedTxBytes).toEqual(claim.claimBytes);
      }
    );
  }
);

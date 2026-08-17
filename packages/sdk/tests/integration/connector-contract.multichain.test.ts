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
 *     shared `balanceProofMessageSolana` message with Ed25519 (deterministic
 *     test key), assert the envelope shape (chain discriminator `solana`, 64-byte
 *     Ed25519 signature in `claimBytes`, channelId/cumulativeAmount/nonce/
 *     recipient present) and round-trip it through `verifyEd25519Signature`.
 *     Then assert `buildSolanaSettlementTx` emits a `SettlementBundle` whose
 *     `unsignedTxBytes` carry the encoding connector's own
 *     `packages/solana-program` accepts — the discriminator, the field order and
 *     the out-of-band Ed25519 precompile instruction, decoded field by field.
 *
 *     A sign -> verify round-trip alone is a CLOSED LOOP and is what let toon#214
 *     hide: the SDK signed and verified a `sha256(...)` digest no deployed
 *     program has ever checked. The byte-level assertions below are the half that
 *     points OUT of this repo, at constants copied from the program source.
 *   - Mina: build the Swap-format claim envelope by signing the shared
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

import type { AccumulatedClaim } from '../../src/settlement/accumulated-claim.js';
import { base58Encode, base58Decode } from '../../src/index.js';
import { balanceProofMessageSolana } from '../../src/settlement/hashes.js';
import { balanceProofFieldsMina } from '../../src/settlement/hashes.js';
import {
  verifyEd25519Signature,
  buildSolanaSettlementTx,
  SOLANA_CLAIM_FROM_CHANNEL_DISCRIMINATOR,
  SOLANA_ED25519_PROGRAM_ID,
  SOLANA_INSTRUCTIONS_SYSVAR_ID,
} from '../../src/settlement/solana.js';
import {
  verifyMinaSignature,
  buildMinaSettlementTx,
  loadMinaSignerClient,
  type MinaSignerClientLike,
} from '../../src/settlement/mina.js';
import type {
  SwapSignerConfig,
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
 * the deployed program consumes it: a 64-byte Ed25519 signature over the raw
 * 48-byte `channel_pda || nonce(8 LE) || transferred_amount(8 LE)` message
 * (`balanceProofMessageSolana`), carried as `claimBytes`.
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

  const message = balanceProofMessageSolana(
    base58Decode(channelId),
    BigInt(nonce),
    BigInt(cumulativeAmount)
  );
  const sig = new Uint8Array(ed25519.sign(message, privateKey));

  const claim: AccumulatedClaim = {
    packetIndex: 0,
    sourceAmount: 1_000_000n,
    targetAmount: 500n,
    claimBytes: sig,
    swapEphemeralPubkey: '0'.repeat(64),
    pair: SOLANA_PAIR,
    receivedAt: Date.now(),
    channelId,
    nonce,
    cumulativeAmount,
    recipient,
    swapSignerAddress: signerAddress,
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
      expect(typeof claim.swapSignerAddress).toBe('string');
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
      const signer: SwapSignerConfig = {
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

    it('the emitted tx matches packages/solana-program byte for byte (toon#214)', () => {
      const { claim, signerAddress } = signedSolanaClaim();
      const programId = base58Encode(fill32(0x66));
      const { unsignedTxBytes } = buildSolanaSettlementTx(
        claim,
        { address: signerAddress, programId },
        claim.recipient!,
        0,
        1
      );

      // --- header + account keys (processor.rs:664-675) ---
      // 1 signer (the fee payer), 0 readonly signers, 4 readonly non-signers.
      expect(Array.from(unsignedTxBytes.slice(0, 3))).toEqual([1, 0, 4]);
      expect(unsignedTxBytes[3]).toBe(6); // short_vec: 6 account keys
      const keyAt = (i: number): string =>
        base58Encode(unsignedTxBytes.slice(4 + i * 32, 4 + (i + 1) * 32));
      expect(keyAt(0)).toBe(claim.recipient); // fee payer, writable signer
      expect(keyAt(1)).toBe(claim.channelId); // channel PDA, writable
      expect(keyAt(2)).toBe(signerAddress); // claimer, readonly
      expect(keyAt(3)).toBe(SOLANA_INSTRUCTIONS_SYSVAR_ID);
      expect(keyAt(4)).toBe(SOLANA_ED25519_PROGRAM_ID);
      expect(keyAt(5)).toBe(programId);

      // --- blockhash placeholder + instruction count ---
      const blockhashOffset = 4 + 6 * 32;
      expect(
        Array.from(unsignedTxBytes.slice(blockhashOffset, blockhashOffset + 32))
      ).toEqual(Array.from(new Uint8Array(32)));
      const ixCountOffset = blockhashOffset + 32;
      expect(unsignedTxBytes[ixCountOffset]).toBe(2);

      // --- instruction 0: the Ed25519 precompile, no accounts, 160B data ---
      let cursor = ixCountOffset + 1;
      expect(unsignedTxBytes[cursor]).toBe(4); // program id index -> Ed25519
      expect(unsignedTxBytes[cursor + 1]).toBe(0); // no accounts
      // 160 = 16 header/offsets + 32 pubkey + 64 signature + 48 message,
      // short_vec-encoded across two bytes.
      expect(Array.from(unsignedTxBytes.slice(cursor + 2, cursor + 4))).toEqual(
        [0xa0, 0x01]
      );
      const edData = unsignedTxBytes.slice(cursor + 4, cursor + 4 + 160);
      expect(edData[0]).toBe(1); // num_signatures
      expect(
        Array.from(edData.slice(48, 112)) // signature
      ).toEqual(Array.from(claim.claimBytes));
      expect(base58Encode(edData.slice(16, 48))).toBe(signerAddress); // pubkey
      expect(Array.from(edData.slice(112, 160))).toEqual(
        Array.from(
          balanceProofMessageSolana(base58Decode(claim.channelId!), 1n, 500n)
        )
      );

      // --- instruction 1: ClaimFromChannel ---
      cursor = cursor + 4 + 160;
      expect(unsignedTxBytes[cursor]).toBe(5); // program id index
      expect(unsignedTxBytes[cursor + 1]).toBe(4); // four accounts…
      // …in the positional order processor.rs reads them: fee_payer, claimer,
      // channel_pda, instructions sysvar.
      expect(Array.from(unsignedTxBytes.slice(cursor + 2, cursor + 6))).toEqual(
        [0, 2, 1, 3]
      );
      expect(unsignedTxBytes[cursor + 6]).toBe(24); // 8 + 8 + 8
      const claimData = unsignedTxBytes.slice(cursor + 7, cursor + 31);
      // instruction.rs:12 CLAIM_FROM_CHANNEL — a flat tag, not an Anchor hash.
      expect(Array.from(claimData.slice(0, 8))).toEqual([
        6, 0, 0, 0, 0, 0, 0, 0,
      ]);
      expect(Array.from(claimData.slice(0, 8))).toEqual(
        Array.from(SOLANA_CLAIM_FROM_CHANNEL_DISCRIMINATOR)
      );
      // nonce (1) then transferred_amount (500), both u64 LE.
      expect(Array.from(claimData.slice(8, 16))).toEqual([
        1, 0, 0, 0, 0, 0, 0, 0,
      ]);
      expect(Array.from(claimData.slice(16, 24))).toEqual([
        0xf4, 0x01, 0, 0, 0, 0, 0, 0,
      ]);
      expect(unsignedTxBytes.length).toBe(cursor + 31);
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
 * Reproduce the Swap's Mina signing path: sign the shared field-element message
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
    swapEphemeralPubkey: '0'.repeat(64),
    pair: MINA_PAIR,
    receivedAt: Date.now(),
    channelId,
    nonce,
    cumulativeAmount,
    recipient,
    swapSignerAddress: keys.publicKey,
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

        // Signature encoding: the Swap emits a base58 mina-signer signature
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
        // Swap signer address is a B62-prefixed Mina public key.
        expect(claim.swapSignerAddress?.startsWith('B62')).toBe(true);
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
        const signer: SwapSignerConfig = { address: signerAddress };
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
        expect(bundle.swapSignerAddress).toBe(signerAddress);
        // Envelope re-emits the verified balance-proof signature verbatim.
        expect(bundle.unsignedTxBytes).toEqual(claim.claimBytes);
      }
    );
  }
);

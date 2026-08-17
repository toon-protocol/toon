/**
 * Solana settlement — REAL on-chain redemption of a `buildSettlementTx` bundle.
 *
 * This is the test toon#214 was missing. Every other check on the Solana
 * settlement path is a closed loop: the SDK signed a digest, the SDK verified
 * the same digest, and the emitted transaction was asserted to be non-empty.
 * That is how a bundle that no Solana validator could ever execute — Anchor-style
 * discriminator, reversed `cumulative || nonce` payload, the 64-byte signature
 * inlined into the program's instruction data instead of an Ed25519 precompile
 * instruction, no Instructions sysvar — passed for months while
 * `settle-received-claims` advertised "Solana settlement".
 *
 * What runs here:
 *   1. A local `solana-test-validator` with the REAL native payment-channel
 *      program (vendored, hash-asserted — see `fixtures/solana/README.md`)
 *      loaded at genesis via `--bpf-program`.
 *   2. A real 178-byte `ChannelState` account, at its correctly-derived PDA and
 *      owned by the program, seeded at genesis via `--account`. Claim redemption
 *      touches no SPL vault, so a channel account is all the program needs —
 *      which keeps this harness free of `spl-token`, deposits and ATAs.
 *   3. `buildSettlementTx` produces the bundle; `patchSolanaRecentBlockhash`
 *      + one Ed25519 signature by the fee payer make it a transaction; the
 *      validator executes it.
 *   4. The channel account is read back and its `nonce_a` /
 *      `transferred_amount_a` slots must have MOVED.
 *
 * Plus the mirror-image negative: the same pipeline fed a claim signed over the
 * LEGACY `balanceProofHashSolana` digest is rejected by the builder, and if the
 * verify is switched off, rejected by the chain — leaving on-chain state
 * untouched. That is the direct, executable demonstration of the defect.
 *
 * Requires `solana-test-validator` on PATH (Agave v2.1.x; v3 hard-requires
 * io_uring, which some sandboxes lack). Absent, this suite SKIPS — unless
 * `SDK_REQUIRE_SOLANA=1`, which turns "not available" into a hard failure so a
 * CI job cannot silently report success having run nothing (the swap#106 lesson).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { SwapPair } from '@toon-protocol/core';

import type { AccumulatedClaim } from '../../src/settlement/accumulated-claim.js';
import { base58Decode, base58Encode } from '../../src/identity.js';
import {
  balanceProofHashSolana,
  balanceProofMessageSolana,
} from '../../src/settlement/hashes.js';
import { buildSettlementTx } from '../../src/settlement/build-settlement-tx.js';
import { patchSolanaRecentBlockhash } from '../../src/settlement/solana.js';

// ---------------------------------------------------------------------------
// Fixture / topology constants
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const PROGRAM_SO = join(HERE, 'fixtures', 'solana', 'payment_channel.so');
/** See fixtures/solana/README.md — must match connector's build byte-for-byte. */
const PROGRAM_SO_BYTES = 109_416;
const PROGRAM_SO_SHA256 =
  'b15e3c808bda581457110193dcdecd060d22c0697b40ce245b4f9188c7497600';

/**
 * connector's `LOCAL_TEST_PROGRAM_ID`
 * (`crates/connector-settlement-solana/src/test_support.rs`), also what swap's
 * E2E harness loads the same binary at. The program has no `declare_id!`, so one
 * shared local id means one shared set of PDAs across repos.
 */
const PROGRAM_ID = 'HY4AYFNe5Vg5BkEwAURNsGY3uFAvGMNpAQPRtgoasJiR';
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';

/**
 * Deliberately NOT swap's 18899/18898: that repo's harness hard-codes those, and
 * a developer running both suites at once must not have one silently attach to
 * the other's validator.
 */
const RPC_PORT = 18999;
const FAUCET_PORT = 18998;
const DYNAMIC_PORT_RANGE = '18960-18990';
const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;

/** ChannelState layout — connector packages/solana-program/src/state.rs. */
const CHANNEL_ACCOUNT_SIZE = 178;
const CHANNEL_DISCRIMINATOR = new Uint8Array([
  0x70,
  0x63,
  0x68,
  0x61,
  0x6e,
  0x6e,
  0x65,
  0x6c, // "pchannel"
]);
const OFFSETS = {
  participantA: 8,
  participantB: 40,
  tokenMint: 72,
  depositA: 104,
  depositB: 112,
  transferredA: 120,
  transferredB: 128,
  nonceA: 136,
  nonceB: 144,
  challengeDuration: 152,
  state: 160,
  closeTimestamp: 161,
  bump: 169,
} as const;

const DEPOSIT_A = 1_000_000n;
const CHALLENGE_DURATION = 3600n;
const CLAIM_NONCE = 1n;
const CLAIM_AMOUNT = 250_000n;
const FEE_PAYER_LAMPORTS = 1_000_000_000;

const PAIR: SwapPair = {
  from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:8453' },
  to: { assetCode: 'USDC', assetScale: 6, chain: 'solana:devnet' },
  rate: '1',
};
const SOLANA_CHAIN = PAIR.to.chain;

const REQUIRE_SOLANA = process.env['SDK_REQUIRE_SOLANA'] === '1';

// ---------------------------------------------------------------------------
// Keys — deterministic, throwaway, local-only
// ---------------------------------------------------------------------------

function seedFor(label: string): Uint8Array {
  return sha256(
    new TextEncoder().encode(`toon-sdk-solana-settlement/${label}`)
  );
}

/** The Swap / claim signer: the channel participant whose balance advances. */
const MAKER_SEED = seedFor('maker');
const MAKER_PUBKEY = base58Encode(
  new Uint8Array(ed25519.getPublicKey(MAKER_SEED))
);
/** The claim recipient: signs + pays for the redemption transaction. */
const RECIPIENT_SEED = seedFor('recipient');
const RECIPIENT_PUBKEY = base58Encode(
  new Uint8Array(ed25519.getPublicKey(RECIPIENT_SEED))
);
/** Any 32 bytes: `claim_from_channel` never touches the mint or a vault. */
const TOKEN_MINT = base58Encode(seedFor('mint'));

// ---------------------------------------------------------------------------
// Byte + PDA helpers (the program's own derivations, in TS)
// ---------------------------------------------------------------------------

function u64LE(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let v = value;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function readU64LE(bytes: Uint8Array, offset: number): bigint {
  let out = 0n;
  for (let i = 0; i < 8; i++) {
    out |= BigInt(bytes[offset + i] as number) << BigInt(i * 8);
  }
  return out;
}

/** True if 32 bytes decode to an Ed25519 curve point — a PDA must NOT. */
function isOnCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(bytes);
    return true;
  } catch {
    return false;
  }
}

/** `Pubkey::find_program_address` — first off-curve bump from 255 down. */
function findProgramAddress(
  seeds: readonly Uint8Array[],
  programId: Uint8Array
): { pda: Uint8Array; bump: number } {
  const marker = new TextEncoder().encode('ProgramDerivedAddress');
  for (let bump = 255; bump >= 0; bump--) {
    const parts = [...seeds, new Uint8Array([bump]), programId, marker];
    const total = parts.reduce((n, p) => n + p.length, 0);
    const buf = new Uint8Array(total);
    let cursor = 0;
    for (const part of parts) {
      buf.set(part, cursor);
      cursor += part.length;
    }
    const candidate = sha256(buf);
    if (!isOnCurve(candidate)) return { pda: candidate, bump };
  }
  throw new Error('no viable PDA bump');
}

/** Seeds `[b"channel", min, max, mint]` — processor.rs `derive_channel_pda`. */
function deriveChannelPda(
  participantA: string,
  participantB: string,
  tokenMint: string,
  programId: string
): { pda: string; bump: number } {
  const a = base58Decode(participantA);
  const b = base58Decode(participantB);
  const sorted = [a, b].sort((x, y) => {
    for (let i = 0; i < 32; i++) {
      const dx = (x[i] as number) - (y[i] as number);
      if (dx !== 0) return dx;
    }
    return 0;
  });
  const { pda, bump } = findProgramAddress(
    [
      new TextEncoder().encode('channel'),
      sorted[0] as Uint8Array,
      sorted[1] as Uint8Array,
      base58Decode(tokenMint),
    ],
    base58Decode(programId)
  );
  return { pda: base58Encode(pda), bump };
}

/** Serialize an Opened `ChannelState` the program will accept and mutate. */
function encodeChannelState(params: {
  participantA: string;
  participantB: string;
  tokenMint: string;
  depositA: bigint;
  bump: number;
}): Uint8Array {
  const data = new Uint8Array(CHANNEL_ACCOUNT_SIZE);
  data.set(CHANNEL_DISCRIMINATOR, 0);
  data.set(base58Decode(params.participantA), OFFSETS.participantA);
  data.set(base58Decode(params.participantB), OFFSETS.participantB);
  data.set(base58Decode(params.tokenMint), OFFSETS.tokenMint);
  data.set(u64LE(params.depositA), OFFSETS.depositA);
  data.set(u64LE(0n), OFFSETS.depositB);
  data.set(u64LE(0n), OFFSETS.transferredA);
  data.set(u64LE(0n), OFFSETS.transferredB);
  data.set(u64LE(0n), OFFSETS.nonceA);
  data.set(u64LE(0n), OFFSETS.nonceB);
  data.set(u64LE(CHALLENGE_DURATION), OFFSETS.challengeDuration);
  data[OFFSETS.state] = 0; // Opened
  data.set(u64LE(0n), OFFSETS.closeTimestamp);
  data[OFFSETS.bump] = params.bump;
  return data;
}

interface DecodedChannel {
  participantA: string;
  participantB: string;
  transferredA: bigint;
  transferredB: bigint;
  nonceA: bigint;
  nonceB: bigint;
  state: number;
}

function decodeChannelState(data: Uint8Array): DecodedChannel {
  expect(data.length).toBe(CHANNEL_ACCOUNT_SIZE);
  expect(Array.from(data.slice(0, 8))).toEqual(
    Array.from(CHANNEL_DISCRIMINATOR)
  );
  return {
    participantA: base58Encode(data.slice(8, 40)),
    participantB: base58Encode(data.slice(40, 72)),
    transferredA: readU64LE(data, OFFSETS.transferredA),
    transferredB: readU64LE(data, OFFSETS.transferredB),
    nonceA: readU64LE(data, OFFSETS.nonceA),
    nonceB: readU64LE(data, OFFSETS.nonceB),
    state: data[OFFSETS.state] as number,
  };
}

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------

interface RpcResult<T> {
  result?: T;
  error?: { code: number; message: string };
}

async function rpc<T>(
  method: string,
  params: unknown[]
): Promise<RpcResult<T>> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await res.json()) as RpcResult<T>;
}

async function rpcOk<T>(method: string, params: unknown[]): Promise<T> {
  const body = await rpc<T>(method, params);
  if (body.error) {
    throw new Error(`${method} failed: ${JSON.stringify(body.error)}`);
  }
  return body.result as T;
}

interface AccountInfoValue {
  data: [string, string];
  owner: string;
  executable: boolean;
}

async function getAccount(pubkey: string): Promise<AccountInfoValue | null> {
  const result = await rpcOk<{ value: AccountInfoValue | null }>(
    'getAccountInfo',
    [pubkey, { encoding: 'base64', commitment: 'confirmed' }]
  );
  return result.value;
}

async function readChannel(pda: string): Promise<DecodedChannel> {
  const account = await getAccount(pda);
  if (!account) throw new Error(`channel account ${pda} not found`);
  expect(account.owner).toBe(PROGRAM_ID);
  return decodeChannelState(
    new Uint8Array(Buffer.from(account.data[0], 'base64'))
  );
}

/** Sign a compiled message with the fee payer and serialize the transaction. */
function serializeTransaction(
  messageBytes: Uint8Array,
  feePayerSeed: Uint8Array
): string {
  const signature = new Uint8Array(ed25519.sign(messageBytes, feePayerSeed));
  const tx = new Uint8Array(1 + 64 + messageBytes.length);
  tx[0] = 1; // short_vec: one signature
  tx.set(signature, 1);
  tx.set(messageBytes, 65);
  return Buffer.from(tx).toString('base64');
}

/** Submit and wait for a status, returning the transaction error (if any). */
async function submit(
  base64Tx: string
): Promise<{ signature?: string; error?: unknown }> {
  const sent = await rpc<string>('sendTransaction', [
    base64Tx,
    { encoding: 'base64', preflightCommitment: 'processed' },
  ]);
  if (sent.error) return { error: sent.error };
  const signature = sent.result as string;
  for (let i = 0; i < 120; i++) {
    const statuses = await rpcOk<{
      value: ({ err: unknown; confirmationStatus: string } | null)[];
    }>('getSignatureStatuses', [
      [signature],
      { searchTransactionHistory: true },
    ]);
    const status = statuses.value[0];
    if (status && status.confirmationStatus !== 'processed') {
      return status.err ? { signature, error: status.err } : { signature };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`transaction ${signature} never confirmed`);
}

// ---------------------------------------------------------------------------
// Validator lifecycle
// ---------------------------------------------------------------------------

function validatorAvailable(): boolean {
  const probe = spawnSync('solana-test-validator', ['--version'], {
    stdio: 'ignore',
  });
  return probe.status === 0;
}

function assertProgramFixture(): void {
  const bytes = readFileSync(PROGRAM_SO);
  const digest = Buffer.from(sha256(new Uint8Array(bytes))).toString('hex');
  if (bytes.length !== PROGRAM_SO_BYTES || digest !== PROGRAM_SO_SHA256) {
    throw new Error(
      `vendored payment_channel.so drifted: ${bytes.length} bytes / ${digest} ` +
        `(expected ${PROGRAM_SO_BYTES} / ${PROGRAM_SO_SHA256}). ` +
        `Refresh it and the constants together — see fixtures/solana/README.md.`
    );
  }
}

/** A genesis account file in the `solana account --output json` shape. */
function writeAccountFile(
  dir: string,
  name: string,
  pubkey: string,
  owner: string,
  lamports: number,
  data: Uint8Array
): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    JSON.stringify({
      pubkey,
      account: {
        lamports,
        data: [Buffer.from(data).toString('base64'), 'base64'],
        owner,
        executable: false,
        rentEpoch: 0,
        space: data.length,
      },
    })
  );
  return path;
}

const channel = deriveChannelPda(
  MAKER_PUBKEY,
  RECIPIENT_PUBKEY,
  TOKEN_MINT,
  PROGRAM_ID
);

let validator: ChildProcess | undefined;
let workDir: string | undefined;
let ready = false;

async function waitFor(
  label: string,
  timeoutMs: number,
  probe: () => Promise<boolean>
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (validator && validator.exitCode !== null) {
      throw new Error(
        `solana-test-validator exited (code ${validator.exitCode}) while waiting for ${label}`
      );
    }
    try {
      if (await probe()) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

beforeAll(async () => {
  if (!validatorAvailable()) {
    if (REQUIRE_SOLANA) {
      throw new Error(
        'SDK_REQUIRE_SOLANA=1 but solana-test-validator is not on PATH. ' +
          'Install Agave v2.1.x: sh -c "$(curl -sSfL https://release.anza.xyz/v2.1.21/install)"'
      );
    }
    console.log(
      'Skipping Solana redemption proof: solana-test-validator not on PATH'
    );
    return;
  }
  assertProgramFixture();

  workDir = mkdtempSync(join(tmpdir(), 'toon-sdk-solana-'));
  const channelAccountFile = writeAccountFile(
    workDir,
    'channel.json',
    channel.pda,
    PROGRAM_ID,
    2_000_000,
    encodeChannelState({
      participantA: MAKER_PUBKEY,
      participantB: RECIPIENT_PUBKEY,
      tokenMint: TOKEN_MINT,
      depositA: DEPOSIT_A,
      bump: channel.bump,
    })
  );
  const feePayerFile = writeAccountFile(
    workDir,
    'fee-payer.json',
    RECIPIENT_PUBKEY,
    SYSTEM_PROGRAM_ID,
    FEE_PAYER_LAMPORTS,
    new Uint8Array(0)
  );

  validator = spawn(
    'solana-test-validator',
    [
      '--ledger',
      join(workDir, 'ledger'),
      '--rpc-port',
      String(RPC_PORT),
      '--faucet-port',
      String(FAUCET_PORT),
      '--dynamic-port-range',
      DYNAMIC_PORT_RANGE,
      '--bpf-program',
      PROGRAM_ID,
      PROGRAM_SO,
      '--account',
      channel.pda,
      channelAccountFile,
      '--account',
      RECIPIENT_PUBKEY,
      feePayerFile,
      '--reset',
      '--quiet',
    ],
    { stdio: 'ignore' }
  );

  await waitFor('validator health', 90_000, async () => {
    const body = await rpc<string>('getHealth', []);
    return body.result === 'ok';
  });
  await waitFor('program at genesis', 30_000, async () => {
    const account = await getAccount(PROGRAM_ID);
    return account !== null && account.executable;
  });
  await waitFor('channel account at genesis', 30_000, async () => {
    const account = await getAccount(channel.pda);
    return account !== null && account.owner === PROGRAM_ID;
  });
  // A loader-v3 program is invocable only from the slot AFTER its
  // ProgramData's `slot`, which for a genesis `--bpf-program` is 0. The
  // validator answers `getHealth: ok` while still at slot 0 for a second or
  // two, and a transaction sent in that window fails with "Program is not
  // deployed" / InstructionError::InvalidAccountData — a confusing error that
  // has nothing to do with the instruction being built. Wait the slot out.
  await waitFor('first slot after genesis', 60_000, async () => {
    const slot = await rpcOk<number>('getSlot', []);
    return slot >= 1;
  });
  ready = true;
}, 180_000);

afterAll(async () => {
  if (validator) {
    validator.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    if (validator.exitCode === null) validator.kill('SIGKILL');
  }
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Claim construction
// ---------------------------------------------------------------------------

function claimSignedForProgram(
  nonce: bigint,
  amount: bigint
): AccumulatedClaim {
  const message = balanceProofMessageSolana(
    base58Decode(channel.pda),
    nonce,
    amount
  );
  return {
    packetIndex: 0,
    sourceAmount: amount,
    targetAmount: amount,
    claimBytes: new Uint8Array(ed25519.sign(message, MAKER_SEED)),
    swapEphemeralPubkey: '0'.repeat(64),
    pair: PAIR,
    receivedAt: Date.now(),
    channelId: channel.pda,
    nonce: nonce.toString(),
    cumulativeAmount: amount.toString(),
    recipient: RECIPIENT_PUBKEY,
    swapSignerAddress: MAKER_PUBKEY,
  };
}

/** The pre-toon#214 scheme: a signature over a digest no program verifies. */
function claimSignedLegacy(nonce: bigint, amount: bigint): AccumulatedClaim {
  const legacy = claimSignedForProgram(nonce, amount);
  const digest = balanceProofHashSolana(
    channel.pda,
    amount,
    nonce,
    RECIPIENT_PUBKEY
  );
  return {
    ...legacy,
    claimBytes: new Uint8Array(ed25519.sign(digest, MAKER_SEED)),
  };
}

function bundleFor(
  claim: AccumulatedClaim,
  verifySignatures = true
): ReturnType<typeof buildSettlementTx> {
  return buildSettlementTx({
    claims: [claim],
    signers: {
      [SOLANA_CHAIN]: { address: MAKER_PUBKEY, programId: PROGRAM_ID },
    },
    recipients: { [SOLANA_CHAIN]: RECIPIENT_PUBKEY },
    verifySignatures,
  });
}

async function redeem(
  claim: AccumulatedClaim,
  verifySignatures = true
): Promise<{ signature?: string; error?: unknown }> {
  const result = bundleFor(claim, verifySignatures);
  expect(result.rejected).toEqual([]);
  const bundle = result.bundles[0];
  expect(bundle).toBeDefined();
  const blockhash = await rpcOk<{ value: { blockhash: string } }>(
    'getLatestBlockhash',
    [{ commitment: 'finalized' }]
  );
  const message = patchSolanaRecentBlockhash(
    (bundle as { unsignedTxBytes: Uint8Array }).unsignedTxBytes,
    blockhash.value.blockhash
  );
  return submit(serializeTransaction(message, RECIPIENT_SEED));
}

// ---------------------------------------------------------------------------
// The proof
// ---------------------------------------------------------------------------

describe.runIf(validatorAvailable() || REQUIRE_SOLANA)(
  'Solana settlement bundle executes against the real program',
  { timeout: 120_000 },
  () => {
    it('[P0] the genesis channel is a real, program-owned ChannelState at its derived PDA', async () => {
      expect(ready).toBe(true);
      const state = await readChannel(channel.pda);
      // The program re-derives this PDA from the stored participants + mint and
      // rejects a mismatch (PaymentChannelError::InvalidPDA), so reading it back
      // through its own layout also proves the derivation above is correct.
      expect(state.participantA).toBe(MAKER_PUBKEY);
      expect(state.participantB).toBe(RECIPIENT_PUBKEY);
      expect(state.state).toBe(0); // Opened
      expect(state.nonceA).toBe(0n);
      expect(state.transferredA).toBe(0n);
    });

    it('[P0] a claim redeems: the transaction executes and on-chain state MOVES', async () => {
      const before = await readChannel(channel.pda);
      expect(before.nonceA).toBe(0n);

      const { signature, error } = await redeem(
        claimSignedForProgram(CLAIM_NONCE, CLAIM_AMOUNT)
      );
      expect(
        error,
        `redemption failed: ${JSON.stringify(error)}`
      ).toBeUndefined();
      expect(signature).toBeTruthy();

      const after = await readChannel(channel.pda);
      // Printed so a CI log carries the evidence that this suite did real work.
      console.log(
        `[solana-redeem] tx ${signature as string} moved ${channel.pda}: ` +
          `nonce_a ${before.nonceA} -> ${after.nonceA}, ` +
          `transferred_amount_a ${before.transferredA} -> ${after.transferredA}`
      );
      // The claimer is participant A, so ITS slots advance — and only those.
      expect(after.nonceA).toBe(CLAIM_NONCE);
      expect(after.transferredA).toBe(CLAIM_AMOUNT);
      expect(after.nonceB).toBe(0n);
      expect(after.transferredB).toBe(0n);
      expect(after.state).toBe(0);
    });

    it('[P0] a second, higher claim advances the same channel again', async () => {
      const nonce = CLAIM_NONCE + 1n;
      const amount = CLAIM_AMOUNT * 2n;
      const { error } = await redeem(claimSignedForProgram(nonce, amount));
      expect(
        error,
        `redemption failed: ${JSON.stringify(error)}`
      ).toBeUndefined();
      const after = await readChannel(channel.pda);
      expect(after.nonceA).toBe(nonce);
      expect(after.transferredA).toBe(amount);
    });

    it('[P0] a replayed nonce is refused BY THE PROGRAM (NonceNotMonotonic), state untouched', async () => {
      const before = await readChannel(channel.pda);
      const { error } = await redeem(
        claimSignedForProgram(before.nonceA, before.transferredA)
      );
      expect(error).toBeDefined();
      const after = await readChannel(channel.pda);
      expect(after.nonceA).toBe(before.nonceA);
      expect(after.transferredA).toBe(before.transferredA);
    });

    it('[P0] a LEGACY-digest claim is refused by the builder, and by the chain if forced (toon#214)', async () => {
      const before = await readChannel(channel.pda);
      const nonce = before.nonceA + 1n;
      const amount = before.transferredA + 1_000n;
      const legacyClaim = claimSignedLegacy(nonce, amount);

      // 1. The builder refuses it rather than handing back an unredeemable bundle.
      const rejectedResult = bundleFor(legacyClaim);
      expect(rejectedResult.bundles).toEqual([]);
      expect(rejectedResult.rejected).toHaveLength(1);
      expect(rejectedResult.rejected[0]?.reason).toBe('SIGNER_MISMATCH');

      // 2. Forced through with verification off, the CHAIN refuses it: the
      //    Ed25519 precompile cannot verify a signature over a different message.
      const { error } = await redeem(legacyClaim, false);
      expect(error).toBeDefined();

      // 3. Nothing moved.
      const after = await readChannel(channel.pda);
      expect(after.nonceA).toBe(before.nonceA);
      expect(after.transferredA).toBe(before.transferredA);
    });
  }
);

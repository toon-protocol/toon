/**
 * E2E Test: Solana Payment Channel Settlement Lifecycle
 *
 * **Prerequisites:**
 * SDK E2E infrastructure running with Solana test-validator:
 * ```bash
 * ./scripts/sdk-e2e-infra.sh up
 * ```
 *
 * **What this test verifies (production-realistic, zero mocks):**
 *
 * On-chain (Solana test-validator at port 19899):
 * - Solana test-validator is healthy and payment channel program is deployed
 * - Channel PDA created with correct participants via initialize_channel
 * - SPL token balance decreases after channel deposit
 * - Ed25519 balance proof signing and on-chain claim verification
 * - Full close + settlement lifecycle with correct final balance redistribution
 *
 * This is the Solana counterpart of the EVM settlement test in
 * docker-publish-event-e2e.test.ts (lines 480-684).
 *
 * Key differences from EVM:
 * - PDA-based channels (derived from [b"channel", min_pubkey, max_pubkey, token_mint])
 * - Ed25519 signatures instead of EIP-712
 * - SPL token accounts (ATAs) instead of ERC-20 approve/transferFrom
 * - No time manipulation needed -- Solana test-validator auto-advances slots
 * - Base58 addresses instead of hex
 * - Uses raw Solana JSON-RPC via fetch (no @solana/kit dependency needed)
 * - Ed25519 signing via @noble/curves (already an SDK dependency)
 *
 * Architecture note: just as the EVM test uses viem directly (not the connector's
 * PaymentChannelSDK), this test uses raw Solana JSON-RPC and @noble/curves
 * directly (not the connector's SolanaPaymentChannelSDK). This keeps the test
 * self-contained with no deep-path connector imports.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as crypto from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { skipIfNotReady } from './helpers/docker-e2e-setup.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOLANA_RPC = 'http://localhost:19899';

/** Well-known Solana program addresses (base58) */
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const RENT_SYSVAR_ID = 'SysvarRent111111111111111111111111111111111';
const CLOCK_SYSVAR_ID = 'SysvarC1ock11111111111111111111111111111111';
const INSTRUCTIONS_SYSVAR_ID = 'Sysvar1nstructions1111111111111111111111111';
const ED25519_PROGRAM_ID = 'Ed25519SigVerify111111111111111111111111111';

/** Challenge duration: 5 seconds (short for fast tests) */
const CHALLENGE_DURATION = 5n;

/** Amount to mint to participant A (in token base units) */
const MINT_AMOUNT = 1_000_000n;

/** Amount participant A deposits into the channel */
const DEPOSIT_AMOUNT = 50_000n;

/** Amount A transfers to B (recorded via balance proof claim) */
const TRANSFER_AMOUNT = 10_000n;

/** On-chain discriminator for channel account: ASCII "pchannel" */
const CHANNEL_DISCRIMINATOR = new Uint8Array([0x70, 0x63, 0x68, 0x61, 0x6e, 0x6e, 0x65, 0x6c]);

/** Instruction discriminators -- must match Rust exactly */
const IX_DISCRIMINATORS = {
  INITIALIZE_CHANNEL: new Uint8Array([0x01, 0, 0, 0, 0, 0, 0, 0]),
  DEPOSIT: new Uint8Array([0x02, 0, 0, 0, 0, 0, 0, 0]),
  CLOSE_CHANNEL: new Uint8Array([0x03, 0, 0, 0, 0, 0, 0, 0]),
  SETTLE_CHANNEL: new Uint8Array([0x04, 0, 0, 0, 0, 0, 0, 0]),
  CLAIM_FROM_CHANNEL: new Uint8Array([0x06, 0, 0, 0, 0, 0, 0, 0]),
} as const;

// ---------------------------------------------------------------------------
// Base58 Encoding/Decoding
// ---------------------------------------------------------------------------

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes: Uint8Array): string {
  // Count leading zeros
  let zeros = 0;
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) zeros++;

  // Convert to bigint
  let value = 0n;
  for (const byte of bytes) {
    value = value * 256n + BigInt(byte);
  }

  let result = '';
  while (value > 0n) {
    result = BASE58_ALPHABET[Number(value % 58n)] + result;
    value = value / 58n;
  }

  // Add leading '1's for leading zeros
  for (let i = 0; i < zeros; i++) {
    result = '1' + result;
  }

  return result || '1';
}

function base58Decode(str: string): Uint8Array {
  // Count leading '1's
  let zeros = 0;
  for (let i = 0; i < str.length && str[i] === '1'; i++) zeros++;

  let value = 0n;
  for (const ch of str) {
    const idx = BASE58_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`Invalid base58 character: ${ch}`);
    value = value * 58n + BigInt(idx);
  }

  // Convert to bytes
  const hex = value === 0n ? '' : value.toString(16).padStart(2, '0');
  const hexPadded = hex.length % 2 ? '0' + hex : hex;
  const rawBytes: number[] = [];
  for (let i = 0; i < hexPadded.length; i += 2) {
    rawBytes.push(parseInt(hexPadded.slice(i, i + 2), 16));
  }

  // Pad to 32 bytes if it looks like a Solana address
  const result = new Uint8Array(zeros + rawBytes.length);
  // Leading zeros are already zero in Uint8Array
  result.set(rawBytes, zeros);
  return result;
}

// ---------------------------------------------------------------------------
// Low-level Helpers
// ---------------------------------------------------------------------------

/** Write a u64 value as little-endian bytes into a Uint8Array at the given offset. */
function writeU64LE(buf: Uint8Array, offset: number, value: bigint): void {
  for (let i = 0; i < 8; i++) {
    buf[offset + i] = Number((value >> BigInt(i * 8)) & 0xffn);
  }
}

/** Read a u64 value as little-endian from a Uint8Array at the given offset. */
function readU64LE(buf: Uint8Array, offset: number): bigint {
  let result = 0n;
  for (let i = 0; i < 8; i++) {
    result |= BigInt(buf[offset + i] ?? 0) << BigInt(i * 8);
  }
  return result;
}

/** Read an i64 value as little-endian from a Uint8Array at the given offset. */
function readI64LE(buf: Uint8Array, offset: number): bigint {
  const unsigned = readU64LE(buf, offset);
  if (unsigned >= 1n << 63n) return unsigned - (1n << 64n);
  return unsigned;
}

/** Write a u32 value as little-endian. */
function writeU32LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >> 8) & 0xff;
  buf[offset + 2] = (value >> 16) & 0xff;
  buf[offset + 3] = (value >> 24) & 0xff;
}

/** Sort two 32-byte pubkeys lexicographically by raw bytes (matches Rust). */
function sortPubkeys(a: Uint8Array, b: Uint8Array): [Uint8Array, Uint8Array] {
  for (let i = 0; i < 32; i++) {
    if ((a[i] ?? 0) < (b[i] ?? 0)) return [a, b];
    if ((a[i] ?? 0) > (b[i] ?? 0)) return [b, a];
  }
  return [a, b];
}

// ---------------------------------------------------------------------------
// Ed25519 Curve Check (for PDA derivation)
// ---------------------------------------------------------------------------

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base = ((base % mod) + mod) % mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

function modInverse(a: bigint, m: bigint): bigint {
  return modPow(((a % m) + m) % m, m - 2n, m);
}

/**
 * Check if 32 bytes represent a point on the Ed25519 curve.
 * Valid PDAs must NOT be on the curve.
 */
function isOnCurve(bytes: Uint8Array): boolean {
  const P = (1n << 255n) - 19n;
  const yBytes = new Uint8Array(32);
  yBytes.set(bytes);
  yBytes[31] = (yBytes[31] ?? 0) & 0x7f;

  let y = 0n;
  for (let i = 0; i < 32; i++) {
    y |= BigInt(yBytes[i] ?? 0) << BigInt(i * 8);
  }

  if (y >= P) return true;

  const y2 = (y * y) % P;
  const D = ((P - ((121665n * modInverse(121666n, P)) % P)) + P) % P;
  const numerator = (y2 - 1n + P) % P;
  const denominator = (D * y2 + 1n) % P;
  const denominatorInv = modInverse(denominator, P);
  const x2 = (numerator * denominatorInv) % P;

  if (x2 === 0n) return true;

  // Euler criterion: x2 is a quadratic residue iff x2^((p-1)/2) === 1 mod p
  return modPow(x2, (P - 1n) / 2n, P) === 1n;
}

// ---------------------------------------------------------------------------
// PDA Derivation
// ---------------------------------------------------------------------------

/**
 * Find a program-derived address (PDA) from seeds and a program ID.
 * Matches Solana's find_program_address algorithm.
 */
function findPDA(seeds: Uint8Array[], programId: Uint8Array): { pda: Uint8Array; bump: number } {
  const PDA_MARKER = new TextEncoder().encode('ProgramDerivedAddress');

  for (let bump = 255; bump >= 0; bump--) {
    const bumpSeed = new Uint8Array([bump]);
    const allSeeds = [...seeds, bumpSeed];

    let totalLen = 0;
    for (const s of allSeeds) totalLen += s.length;
    totalLen += programId.length + PDA_MARKER.length;

    const hashInput = new Uint8Array(totalLen);
    let offset = 0;
    for (const s of allSeeds) {
      hashInput.set(s, offset);
      offset += s.length;
    }
    hashInput.set(programId, offset);
    offset += programId.length;
    hashInput.set(PDA_MARKER, offset);

    const hash = crypto.createHash('sha256').update(hashInput).digest();
    const hashBytes = new Uint8Array(hash);

    if (!isOnCurve(hashBytes)) {
      return { pda: hashBytes, bump };
    }
  }
  throw new Error('Could not find a viable PDA bump seed');
}

/**
 * Derive a channel PDA.
 * Seeds: [b"channel", min_pubkey, max_pubkey, token_mint]
 */
function deriveChannelPDA(
  participantA: Uint8Array,
  participantB: Uint8Array,
  tokenMint: Uint8Array,
  programId: Uint8Array
): { pda: Uint8Array; bump: number } {
  const [min, max] = sortPubkeys(participantA, participantB);
  const seeds = [
    new TextEncoder().encode('channel'),
    min,
    max,
    tokenMint,
  ];
  return findPDA(seeds, programId);
}

/**
 * Derive a vault PDA from a channel PDA.
 * Seeds: [b"vault", channel_pda]
 */
function deriveVaultPDA(
  channelPDA: Uint8Array,
  programId: Uint8Array
): { pda: Uint8Array; bump: number } {
  return findPDA([new TextEncoder().encode('vault'), channelPDA], programId);
}

/**
 * Derive an Associated Token Account (ATA) address.
 * Seeds: [wallet, TOKEN_PROGRAM, mint] under ASSOCIATED_TOKEN_PROGRAM
 */
function deriveATA(wallet: Uint8Array, mint: Uint8Array): Uint8Array {
  const tokenProgram = base58Decode(TOKEN_PROGRAM_ID);
  const atProgram = base58Decode(ASSOCIATED_TOKEN_PROGRAM_ID);
  const { pda } = findPDA([wallet, tokenProgram, mint], atProgram);
  return pda;
}

// ---------------------------------------------------------------------------
// Solana JSON-RPC Helpers
// ---------------------------------------------------------------------------

let rpcIdCounter = 1;

async function solanaRpc(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(SOLANA_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
      id: rpcIdCounter++,
    }),
    signal: AbortSignal.timeout(30000),
  });
  const json = (await res.json()) as { result?: unknown; error?: { message: string; code: number } };
  if (json.error) {
    throw new Error(`Solana RPC error [${method}]: ${json.error.message} (code ${json.error.code})`);
  }
  return json.result;
}

async function getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  const result = (await solanaRpc('getLatestBlockhash', [{ commitment: 'confirmed' }])) as {
    value: { blockhash: string; lastValidBlockHeight: number };
  };
  return result.value;
}

async function requestAirdrop(pubkey: string, lamports: number): Promise<string> {
  return (await solanaRpc('requestAirdrop', [pubkey, lamports])) as string;
}

async function getAccountInfo(pubkey: string): Promise<{
  data: [string, string];
  executable: boolean;
  lamports: number;
  owner: string;
} | null> {
  const result = (await solanaRpc('getAccountInfo', [pubkey, { encoding: 'base64' }])) as {
    value: { data: [string, string]; executable: boolean; lamports: number; owner: string } | null;
  };
  return result.value;
}

async function getMinimumBalanceForRentExemption(dataLen: number): Promise<number> {
  return (await solanaRpc('getMinimumBalanceForRentExemption', [dataLen])) as number;
}

async function sendRawTransaction(serializedTx: string): Promise<string> {
  return (await solanaRpc('sendTransaction', [
    serializedTx,
    { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed' },
  ])) as string;
}

async function waitForConfirmation(signature: string, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = (await solanaRpc('getSignatureStatuses', [[signature]])) as {
      value: ({ confirmationStatus: string } | null)[];
    };
    const status = result.value[0];
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Transaction ${signature} not confirmed within ${timeoutMs}ms`);
}

/**
 * Get SPL token balance from a token account.
 * Returns 0n if the account doesn't exist.
 */
async function getSplTokenBalance(tokenAccountPubkey: string): Promise<bigint> {
  const info = await getAccountInfo(tokenAccountPubkey);
  if (!info) return 0n;
  const rawBytes = Buffer.from(info.data[0], 'base64');
  if (rawBytes.length < 72) return 0n;
  return readU64LE(new Uint8Array(rawBytes), 64);
}

// ---------------------------------------------------------------------------
// Transaction Building (Solana v0 message format)
// ---------------------------------------------------------------------------

/**
 * Represents a Solana instruction for building transactions.
 */
interface SolanaInstruction {
  programIdIndex: number;
  accountIndices: number[];
  data: Uint8Array;
}

/**
 * Account metadata for transaction building.
 */
interface AccountEntry {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

/**
 * Build, sign, and send a Solana legacy transaction.
 *
 * We build a legacy (non-versioned) transaction since it avoids
 * the complexity of address lookup tables and the test-validator
 * handles both formats identically.
 */
async function buildAndSendTransaction(
  feePayer: { publicKey: Uint8Array; privateKey: Uint8Array },
  instructions: {
    programId: string;
    keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
    data: Uint8Array;
  }[],
  additionalSigners: { publicKey: Uint8Array; privateKey: Uint8Array }[] = []
): Promise<string> {
  const { blockhash } = await getLatestBlockhash();
  const feePayerPubkey = base58Encode(feePayer.publicKey);

  // Collect all unique accounts, sorting by: signers+writable, signers+readonly,
  // non-signers+writable, non-signers+readonly. Fee payer is always first.
  const accountMap = new Map<string, AccountEntry>();

  // Fee payer first
  accountMap.set(feePayerPubkey, { pubkey: feePayerPubkey, isSigner: true, isWritable: true });

  for (const ix of instructions) {
    for (const key of ix.keys) {
      const existing = accountMap.get(key.pubkey);
      if (existing) {
        existing.isSigner = existing.isSigner || key.isSigner;
        existing.isWritable = existing.isWritable || key.isWritable;
      } else {
        accountMap.set(key.pubkey, { ...key });
      }
    }
    // Program ID is a non-signer, read-only account
    if (!accountMap.has(ix.programId)) {
      accountMap.set(ix.programId, { pubkey: ix.programId, isSigner: false, isWritable: false });
    }
  }

  // Sort: signer+writable, signer+readonly, non-signer+writable, non-signer+readonly
  const accounts = [...accountMap.values()].sort((a, b) => {
    if (a.pubkey === feePayerPubkey) return -1;
    if (b.pubkey === feePayerPubkey) return 1;
    const aScore = (a.isSigner ? 2 : 0) + (a.isWritable ? 1 : 0);
    const bScore = (b.isSigner ? 2 : 0) + (b.isWritable ? 1 : 0);
    return bScore - aScore;
  });

  const numSigners = accounts.filter((a) => a.isSigner).length;
  const numReadonlySigners = accounts.filter((a) => a.isSigner && !a.isWritable).length;
  const numReadonlyNonSigners = accounts.filter((a) => !a.isSigner && !a.isWritable).length;

  const accountIndexMap = new Map<string, number>();
  accounts.forEach((a, i) => accountIndexMap.set(a.pubkey, i));

  // Build compiled instructions
  const compiledInstructions: SolanaInstruction[] = instructions.map((ix) => ({
    programIdIndex: accountIndexMap.get(ix.programId)!,
    accountIndices: ix.keys.map((k) => accountIndexMap.get(k.pubkey)!),
    data: ix.data,
  }));

  // Serialize the legacy message
  // Format: header (3 bytes) + account keys (32 * n) + recent blockhash (32) + instructions
  const blockhashBytes = base58Decode(blockhash);

  // Calculate total instruction data size
  let instructionSize = 0;
  instructionSize += 1; // compact-u16 instruction count
  for (const ix of compiledInstructions) {
    instructionSize += 1; // program id index
    instructionSize += 1 + ix.accountIndices.length; // compact-u16 account count + indices
    instructionSize += 1 + ix.data.length; // compact-u16 data length + data
    // Handle compact-u16 for longer lengths
    if (ix.accountIndices.length >= 128) instructionSize += 1;
    if (ix.data.length >= 128) instructionSize += 1;
    if (ix.data.length >= 16384) instructionSize += 1;
  }

  const messageSize = 3 + (32 * accounts.length) + 32 + instructionSize;
  const message = new Uint8Array(messageSize);
  let offset = 0;

  // Header
  message[offset++] = numSigners;
  message[offset++] = numReadonlySigners;
  message[offset++] = numReadonlyNonSigners;

  // Account keys
  for (const acct of accounts) {
    const key = base58Decode(acct.pubkey);
    // Pad or trim to 32 bytes
    const keyPadded = new Uint8Array(32);
    keyPadded.set(key.slice(0, 32), 32 - Math.min(key.length, 32));
    if (key.length <= 32) {
      keyPadded.set(key, 32 - key.length);
    }
    message.set(keyPadded, offset);
    offset += 32;
  }

  // Recent blockhash
  const bhPadded = new Uint8Array(32);
  if (blockhashBytes.length <= 32) {
    bhPadded.set(blockhashBytes, 32 - blockhashBytes.length);
  }
  message.set(bhPadded, offset);
  offset += 32;

  // Instructions (compact-u16 encoded count)
  offset = writeCompactU16(message, offset, compiledInstructions.length);

  for (const ix of compiledInstructions) {
    message[offset++] = ix.programIdIndex;
    offset = writeCompactU16(message, offset, ix.accountIndices.length);
    for (const idx of ix.accountIndices) {
      message[offset++] = idx;
    }
    offset = writeCompactU16(message, offset, ix.data.length);
    message.set(ix.data, offset);
    offset += ix.data.length;
  }

  const finalMessage = message.slice(0, offset);

  // Sign the message
  const allSigners = [feePayer, ...additionalSigners];
  const signerPubkeys = accounts.filter((a) => a.isSigner).map((a) => a.pubkey);

  // Build signatures array (64 bytes each, in account order)
  const signatures: Uint8Array[] = [];
  for (const signerPubkey of signerPubkeys) {
    const signer = allSigners.find((s) => base58Encode(s.publicKey) === signerPubkey);
    if (!signer) {
      throw new Error(`Missing signer for ${signerPubkey}`);
    }
    const sig = ed25519.sign(finalMessage, signer.privateKey);
    signatures.push(sig);
  }

  // Serialize the full transaction: compact-u16 sig count + signatures + message
  const txSize = 1 + (signatures.length * 64) + finalMessage.length;
  const tx = new Uint8Array(txSize);
  let txOffset = 0;
  txOffset = writeCompactU16(tx, txOffset, signatures.length);
  for (const sig of signatures) {
    tx.set(sig, txOffset);
    txOffset += 64;
  }
  tx.set(finalMessage, txOffset);

  const txBase64 = Buffer.from(tx.slice(0, txOffset + finalMessage.length)).toString('base64');
  const txSig = await sendRawTransaction(txBase64);
  await waitForConfirmation(txSig);
  return txSig;
}

/** Write a compact-u16 value and return the new offset. */
function writeCompactU16(buf: Uint8Array, offset: number, value: number): number {
  if (value < 0x80) {
    buf[offset++] = value;
  } else if (value < 0x4000) {
    buf[offset++] = (value & 0x7f) | 0x80;
    buf[offset++] = value >> 7;
  } else {
    buf[offset++] = (value & 0x7f) | 0x80;
    buf[offset++] = ((value >> 7) & 0x7f) | 0x80;
    buf[offset++] = value >> 14;
  }
  return offset;
}

// ---------------------------------------------------------------------------
// Keypair Generation
// ---------------------------------------------------------------------------

interface Keypair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  pubkeyBase58: string;
}

function generateKeypair(): Keypair {
  const privateKey = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  return {
    publicKey,
    privateKey,
    pubkeyBase58: base58Encode(publicKey),
  };
}

// ---------------------------------------------------------------------------
// SPL Token Operations (raw instruction building)
// ---------------------------------------------------------------------------

async function createMint(
  payer: Keypair,
  mintKeypair: Keypair,
  mintAuthority: string,
  decimals: number
): Promise<void> {
  const rentExempt = await getMinimumBalanceForRentExemption(82);

  // Instruction 1: SystemProgram.CreateAccount
  const createAccountData = new Uint8Array(52);
  writeU32LE(createAccountData, 0, 0); // Padding (instruction data starts at lamports)
  // Actually SystemProgram::CreateAccount = instruction index 0 as u32 LE
  // Followed by: lamports (u64 LE) + space (u64 LE) + owner (32 bytes)
  const createIxData = new Uint8Array(4 + 8 + 8 + 32);
  writeU32LE(createIxData, 0, 0); // CreateAccount instruction index
  writeU64LE(createIxData, 4, BigInt(rentExempt));
  writeU64LE(createIxData, 12, 82n);
  createIxData.set(base58Decode(TOKEN_PROGRAM_ID), 20);

  // Instruction 2: InitializeMint
  // Layout: instruction_type (1 byte = 0) + decimals (1) + mint_authority (32) + option (1) + freeze_authority (32)
  const initMintData = new Uint8Array(67);
  initMintData[0] = 0; // InitializeMint
  initMintData[1] = decimals;
  const authorityBytes = base58Decode(mintAuthority);
  initMintData.set(authorityBytes.length <= 32 ? padTo32(authorityBytes) : authorityBytes.slice(0, 32), 2);
  initMintData[34] = 0; // No freeze authority

  await buildAndSendTransaction(
    payer,
    [
      {
        programId: SYSTEM_PROGRAM_ID,
        keys: [
          { pubkey: payer.pubkeyBase58, isSigner: true, isWritable: true },
          { pubkey: mintKeypair.pubkeyBase58, isSigner: true, isWritable: true },
        ],
        data: createIxData,
      },
      {
        programId: TOKEN_PROGRAM_ID,
        keys: [
          { pubkey: mintKeypair.pubkeyBase58, isSigner: false, isWritable: true },
          { pubkey: RENT_SYSVAR_ID, isSigner: false, isWritable: false },
        ],
        data: initMintData,
      },
    ],
    [mintKeypair]
  );
}

async function createAssociatedTokenAccount(
  payer: Keypair,
  wallet: string,
  mint: string
): Promise<string> {
  const walletBytes = padTo32(base58Decode(wallet));
  const mintBytes = padTo32(base58Decode(mint));
  const ataBytes = deriveATA(walletBytes, mintBytes);
  const ataAddress = base58Encode(ataBytes);

  // Check if already exists
  const info = await getAccountInfo(ataAddress);
  if (info) return ataAddress;

  // Create ATA instruction (empty data)
  await buildAndSendTransaction(payer, [
    {
      programId: ASSOCIATED_TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: payer.pubkeyBase58, isSigner: true, isWritable: true },
        { pubkey: ataAddress, isSigner: false, isWritable: true },
        { pubkey: wallet, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: new Uint8Array(0),
    },
  ]);

  return ataAddress;
}

async function mintTo(
  payer: Keypair,
  mint: string,
  destination: string,
  mintAuthority: Keypair,
  amount: bigint
): Promise<void> {
  const data = new Uint8Array(9);
  data[0] = 7; // MintTo instruction
  writeU64LE(data, 1, amount);

  const signers = mintAuthority.pubkeyBase58 === payer.pubkeyBase58 ? [] : [mintAuthority];

  await buildAndSendTransaction(
    payer,
    [
      {
        programId: TOKEN_PROGRAM_ID,
        keys: [
          { pubkey: mint, isSigner: false, isWritable: true },
          { pubkey: destination, isSigner: false, isWritable: true },
          { pubkey: mintAuthority.pubkeyBase58, isSigner: true, isWritable: false },
        ],
        data,
      },
    ],
    signers
  );
}

/** Pad a byte array to 32 bytes (left-pad with zeros). */
function padTo32(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 32) return bytes;
  if (bytes.length > 32) return bytes.slice(bytes.length - 32);
  const padded = new Uint8Array(32);
  padded.set(bytes, 32 - bytes.length);
  return padded;
}

// ---------------------------------------------------------------------------
// Channel State Deserialization
// ---------------------------------------------------------------------------

interface ChannelState {
  participantA: string;
  participantB: string;
  tokenMint: string;
  depositA: bigint;
  depositB: bigint;
  transferredAmountA: bigint;
  transferredAmountB: bigint;
  nonceA: bigint;
  nonceB: bigint;
  challengeDuration: bigint;
  state: 'opened' | 'closed' | 'settled';
  closeTimestamp: bigint;
  bump: number;
}

function deserializeChannelState(data: Uint8Array): ChannelState {
  if (data.length < 178) {
    throw new Error(`Channel data too short: ${data.length} bytes (need 178)`);
  }

  // Verify discriminator
  for (let i = 0; i < 8; i++) {
    if (data[i] !== CHANNEL_DISCRIMINATOR[i]) {
      throw new Error('Invalid channel discriminator');
    }
  }

  const stateMap = ['opened', 'closed', 'settled'] as const;
  const stateByte = data[160] ?? 0;

  return {
    participantA: base58Encode(data.slice(8, 40)),
    participantB: base58Encode(data.slice(40, 72)),
    tokenMint: base58Encode(data.slice(72, 104)),
    depositA: readU64LE(data, 104),
    depositB: readU64LE(data, 112),
    transferredAmountA: readU64LE(data, 120),
    transferredAmountB: readU64LE(data, 128),
    nonceA: readU64LE(data, 136),
    nonceB: readU64LE(data, 144),
    challengeDuration: readU64LE(data, 152),
    state: stateMap[stateByte] ?? 'opened',
    closeTimestamp: readI64LE(data, 161),
    bump: data[169] ?? 0,
  };
}

async function fetchChannelState(channelPDA: string): Promise<ChannelState> {
  const info = await getAccountInfo(channelPDA);
  if (!info) throw new Error(`Channel account not found: ${channelPDA}`);
  const rawBytes = new Uint8Array(Buffer.from(info.data[0], 'base64'));
  return deserializeChannelState(rawBytes);
}

// ---------------------------------------------------------------------------
// Payment Channel Instructions
// ---------------------------------------------------------------------------

async function openChannel(
  payer: Keypair,
  participantA: Keypair,
  participantB: Keypair,
  mintPubkey: string,
  programId: string,
  challengeDuration: bigint
): Promise<string> {
  const aBytes = padTo32(participantA.publicKey);
  const bBytes = padTo32(participantB.publicKey);
  const mintBytes = padTo32(base58Decode(mintPubkey));
  const programBytes = padTo32(base58Decode(programId));

  const { pda: channelPDABytes } = deriveChannelPDA(aBytes, bBytes, mintBytes, programBytes);
  const channelPDA = base58Encode(channelPDABytes);

  const { pda: vaultPDABytes } = deriveVaultPDA(channelPDABytes, programBytes);
  const vaultPDA = base58Encode(vaultPDABytes);

  // Instruction data: discriminator (8) + challenge_duration (8)
  const ixData = new Uint8Array(16);
  ixData.set(IX_DISCRIMINATORS.INITIALIZE_CHANNEL, 0);
  writeU64LE(ixData, 8, challengeDuration);

  const signers = payer.pubkeyBase58 === participantA.pubkeyBase58 ? [] : [participantA];

  await buildAndSendTransaction(
    payer,
    [
      {
        programId,
        keys: [
          { pubkey: payer.pubkeyBase58, isSigner: true, isWritable: true },
          { pubkey: participantA.pubkeyBase58, isSigner: false, isWritable: false },
          { pubkey: participantB.pubkeyBase58, isSigner: false, isWritable: false },
          { pubkey: mintPubkey, isSigner: false, isWritable: false },
          { pubkey: channelPDA, isSigner: false, isWritable: true },
          { pubkey: vaultPDA, isSigner: false, isWritable: true },
          { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: RENT_SYSVAR_ID, isSigner: false, isWritable: false },
        ],
        data: ixData,
      },
    ],
    signers
  );

  return channelPDA;
}

async function depositToChannel(
  depositor: Keypair,
  channelPDA: string,
  depositorTokenAccount: string,
  programId: string,
  amount: bigint
): Promise<string> {
  const programBytes = padTo32(base58Decode(programId));
  const channelPDABytes = padTo32(base58Decode(channelPDA));
  const { pda: vaultPDABytes } = deriveVaultPDA(channelPDABytes, programBytes);
  const vaultPDA = base58Encode(vaultPDABytes);

  const ixData = new Uint8Array(16);
  ixData.set(IX_DISCRIMINATORS.DEPOSIT, 0);
  writeU64LE(ixData, 8, amount);

  return buildAndSendTransaction(depositor, [
    {
      programId,
      keys: [
        { pubkey: depositor.pubkeyBase58, isSigner: true, isWritable: false },
        { pubkey: depositorTokenAccount, isSigner: false, isWritable: true },
        { pubkey: vaultPDA, isSigner: false, isWritable: true },
        { pubkey: channelPDA, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: ixData,
    },
  ]);
}

/**
 * Build the canonical 48-byte balance proof message.
 * Format: channel_pda (32 bytes) || nonce (8 bytes LE) || transferred_amount (8 bytes LE)
 */
function buildBalanceProofMessage(
  channelPDA: string,
  nonce: bigint,
  transferredAmount: bigint
): Uint8Array {
  const message = new Uint8Array(48);
  const pdaBytes = padTo32(base58Decode(channelPDA));
  message.set(pdaBytes, 0);
  writeU64LE(message, 32, nonce);
  writeU64LE(message, 40, transferredAmount);
  return message;
}

/**
 * Sign a balance proof with Ed25519.
 */
function signBalanceProof(
  channelPDA: string,
  nonce: bigint,
  transferredAmount: bigint,
  signer: Keypair
): Uint8Array {
  const message = buildBalanceProofMessage(channelPDA, nonce, transferredAmount);
  return ed25519.sign(message, signer.privateKey);
}

/**
 * Build an Ed25519 precompile verification instruction (inline data variant).
 */
function buildEd25519PrecompileIx(
  signature: Uint8Array,
  pubkey: Uint8Array,
  message: Uint8Array
): { programId: string; keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: Uint8Array } {
  const HEADER_SIZE = 16;
  const totalSize = HEADER_SIZE + 64 + 32 + message.length;
  const ixData = new Uint8Array(totalSize);

  // Header
  ixData[0] = 1; // num_signatures
  ixData[1] = 0; // padding

  const sigOffset = HEADER_SIZE;
  const pkOffset = sigOffset + 64;
  const msgOffset = pkOffset + 32;

  // signature_offset (u16 LE)
  ixData[2] = sigOffset & 0xff;
  ixData[3] = (sigOffset >> 8) & 0xff;
  ixData[4] = 0xff; ixData[5] = 0xff; // same instruction

  // public_key_offset (u16 LE)
  ixData[6] = pkOffset & 0xff;
  ixData[7] = (pkOffset >> 8) & 0xff;
  ixData[8] = 0xff; ixData[9] = 0xff;

  // message_data_offset (u16 LE)
  ixData[10] = msgOffset & 0xff;
  ixData[11] = (msgOffset >> 8) & 0xff;
  // message_data_size (u16 LE)
  ixData[12] = message.length & 0xff;
  ixData[13] = (message.length >> 8) & 0xff;
  ixData[14] = 0xff; ixData[15] = 0xff;

  // Inline data
  ixData.set(signature, sigOffset);
  ixData.set(pubkey, pkOffset);
  ixData.set(message, msgOffset);

  return {
    programId: ED25519_PROGRAM_ID,
    keys: [],
    data: ixData,
  };
}

async function claimFromChannel(
  claimer: Keypair,
  channelPDA: string,
  programId: string,
  nonce: bigint,
  transferredAmount: bigint,
  signature: Uint8Array
): Promise<string> {
  const balanceProofMsg = buildBalanceProofMessage(channelPDA, nonce, transferredAmount);

  // Instruction 0: Ed25519 precompile
  const ed25519Ix = buildEd25519PrecompileIx(signature, claimer.publicKey, balanceProofMsg);

  // Instruction 1: claim_from_channel
  const claimData = new Uint8Array(24);
  claimData.set(IX_DISCRIMINATORS.CLAIM_FROM_CHANNEL, 0);
  writeU64LE(claimData, 8, nonce);
  writeU64LE(claimData, 16, transferredAmount);

  return buildAndSendTransaction(claimer, [
    ed25519Ix,
    {
      programId,
      keys: [
        { pubkey: claimer.pubkeyBase58, isSigner: true, isWritable: false },
        { pubkey: channelPDA, isSigner: false, isWritable: true },
        { pubkey: INSTRUCTIONS_SYSVAR_ID, isSigner: false, isWritable: false },
      ],
      data: claimData,
    },
  ]);
}

async function closeChannel(
  closer: Keypair,
  channelPDA: string,
  programId: string
): Promise<string> {
  return buildAndSendTransaction(closer, [
    {
      programId,
      keys: [
        { pubkey: closer.pubkeyBase58, isSigner: true, isWritable: false },
        { pubkey: channelPDA, isSigner: false, isWritable: true },
        { pubkey: CLOCK_SYSVAR_ID, isSigner: false, isWritable: false },
      ],
      data: new Uint8Array(IX_DISCRIMINATORS.CLOSE_CHANNEL),
    },
  ]);
}

async function settleChannel(
  caller: Keypair,
  channelPDA: string,
  participantAToken: string,
  participantBToken: string,
  rentRecipient: string,
  programId: string
): Promise<string> {
  const programBytes = padTo32(base58Decode(programId));
  const channelPDABytes = padTo32(base58Decode(channelPDA));
  const { pda: vaultPDABytes } = deriveVaultPDA(channelPDABytes, programBytes);
  const vaultPDA = base58Encode(vaultPDABytes);

  return buildAndSendTransaction(caller, [
    {
      programId,
      keys: [
        { pubkey: caller.pubkeyBase58, isSigner: true, isWritable: false },
        { pubkey: channelPDA, isSigner: false, isWritable: true },
        { pubkey: vaultPDA, isSigner: false, isWritable: true },
        { pubkey: participantAToken, isSigner: false, isWritable: true },
        { pubkey: participantBToken, isSigner: false, isWritable: true },
        { pubkey: rentRecipient, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: CLOCK_SYSVAR_ID, isSigner: false, isWritable: false },
      ],
      data: new Uint8Array(IX_DISCRIMINATORS.SETTLE_CHANNEL),
    },
  ]);
}

// ---------------------------------------------------------------------------
// Health & Discovery
// ---------------------------------------------------------------------------

async function checkSolanaHealth(): Promise<boolean> {
  try {
    const result = await solanaRpc('getHealth');
    return result === 'ok';
  } catch {
    return false;
  }
}

/**
 * Discover the deployed payment channel program ID.
 * Queries all executable accounts owned by BPFLoaderUpgradeable.
 * The program account is exactly 36 bytes (4-byte type + 32-byte programdata address).
 */
async function discoverProgramId(): Promise<string | null> {
  try {
    const BPF_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
    const result = (await solanaRpc('getProgramAccounts', [
      BPF_LOADER,
      { encoding: 'base64' },
    ])) as { pubkey: string; account: { data: [string, string] } }[];

    const programs = result.filter((acct) => {
      const raw = Buffer.from(acct.account.data[0], 'base64');
      return raw.length === 36;
    });

    if (programs.length === 0) return null;
    return programs[0]!.pubkey;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('Docker Solana Settlement E2E', () => {
  let solanaReady = false;
  let programId: string;

  // Participants
  let payer: Keypair;
  let participantA: Keypair;
  let participantB: Keypair;

  // Token infrastructure
  let mintKeypair: Keypair;
  let ataA: string;
  let ataB: string;

  // Channel state
  let channelPDA: string;

  beforeAll(async () => {
    // -------------------------------------------------------------------
    // Phase 1: Health check -- Solana test-validator must be running
    // -------------------------------------------------------------------
    const healthy = await checkSolanaHealth();
    if (!healthy) {
      console.warn(
        'Solana test-validator not running at port 19899. Run: ./scripts/sdk-e2e-infra.sh up'
      );
      return;
    }

    // -------------------------------------------------------------------
    // Phase 2: Discover the deployed payment channel program ID
    // -------------------------------------------------------------------
    const discovered = await discoverProgramId();
    if (!discovered) {
      console.warn(
        'No payment channel program found on Solana test-validator. ' +
          'Ensure payment_channel.so is built in the connector repo at ' +
          'packages/solana-program/target/deploy/'
      );
      return;
    }
    programId = discovered;
    console.log(`Discovered Solana program ID: ${programId}`);

    // -------------------------------------------------------------------
    // Phase 3: Generate keypairs and fund with SOL
    // -------------------------------------------------------------------
    payer = generateKeypair();
    participantA = generateKeypair();
    participantB = generateKeypair();

    // Airdrop SOL for transaction fees
    const airdropSig1 = await requestAirdrop(payer.pubkeyBase58, 10_000_000_000);
    await waitForConfirmation(airdropSig1);
    const airdropSig2 = await requestAirdrop(participantA.pubkeyBase58, 2_000_000_000);
    await waitForConfirmation(airdropSig2);
    const airdropSig3 = await requestAirdrop(participantB.pubkeyBase58, 2_000_000_000);
    await waitForConfirmation(airdropSig3);

    // -------------------------------------------------------------------
    // Phase 4: Create SPL token mint and mint tokens to participant A
    // -------------------------------------------------------------------
    mintKeypair = generateKeypair();
    await createMint(payer, mintKeypair, payer.pubkeyBase58, 6);

    // Create ATAs for both participants
    ataA = await createAssociatedTokenAccount(
      payer,
      participantA.pubkeyBase58,
      mintKeypair.pubkeyBase58
    );
    ataB = await createAssociatedTokenAccount(
      payer,
      participantB.pubkeyBase58,
      mintKeypair.pubkeyBase58
    );

    // Mint tokens to participant A (the depositor)
    await mintTo(payer, mintKeypair.pubkeyBase58, ataA, payer, MINT_AMOUNT);

    solanaReady = true;
  }, 120000);

  // =========================================================================
  // TEST: Solana test-validator is healthy and program deployed
  // =========================================================================

  it('Solana test-validator is healthy and program deployed', async () => {
    if (skipIfNotReady(solanaReady)) return;

    // Verify health via JSON-RPC
    const healthOk = await checkSolanaHealth();
    expect(healthOk).toBe(true);

    // Verify program exists at discovered address
    const info = await getAccountInfo(programId);
    expect(info).not.toBeNull();
    expect(info!.executable).toBe(true);

    console.log(`Program ID: ${programId}`);
    console.log(`Participant A: ${participantA.pubkeyBase58}`);
    console.log(`Participant B: ${participantB.pubkeyBase58}`);
    console.log(`Token Mint: ${mintKeypair.pubkeyBase58}`);
  });

  // =========================================================================
  // TEST: Channel open creates PDA with correct participants
  // =========================================================================

  it('channel open creates PDA with correct participants', async () => {
    if (skipIfNotReady(solanaReady)) return;

    // Derive expected PDA before opening
    const aBytes = padTo32(participantA.publicKey);
    const bBytes = padTo32(participantB.publicKey);
    const mintBytes = padTo32(base58Decode(mintKeypair.pubkeyBase58));
    const progBytes = padTo32(base58Decode(programId));
    const { pda: expectedPDABytes } = deriveChannelPDA(aBytes, bBytes, mintBytes, progBytes);
    const expectedPDA = base58Encode(expectedPDABytes);

    // Open channel (payer pays for account creation)
    channelPDA = await openChannel(
      payer,
      participantA,
      participantB,
      mintKeypair.pubkeyBase58,
      programId,
      CHALLENGE_DURATION
    );
    expect(channelPDA).toBe(expectedPDA);

    // Verify on-chain state
    const state = await fetchChannelState(channelPDA);
    expect(state.state).toBe('opened');
    expect(state.challengeDuration).toBe(CHALLENGE_DURATION);

    // Verify participants are correctly stored (order may be sorted)
    const participants = [state.participantA, state.participantB].sort();
    const expected = [participantA.pubkeyBase58, participantB.pubkeyBase58].sort();
    expect(participants).toEqual(expected);

    // Verify token mint
    expect(state.tokenMint).toBe(mintKeypair.pubkeyBase58);

    // Verify initial deposits and transfers are zero
    expect(state.depositA).toBe(0n);
    expect(state.depositB).toBe(0n);
    expect(state.transferredAmountA).toBe(0n);
    expect(state.transferredAmountB).toBe(0n);
  });

  // =========================================================================
  // TEST: SPL token balance decreases after channel deposit
  // =========================================================================

  it('SPL token balance decreases after channel deposit', async () => {
    if (skipIfNotReady(solanaReady)) return;

    // Record balance before deposit
    const balanceBefore = await getSplTokenBalance(ataA);
    expect(balanceBefore).toBe(MINT_AMOUNT);

    // Deposit from participant A
    const txSig = await depositToChannel(
      participantA,
      channelPDA,
      ataA,
      programId,
      DEPOSIT_AMOUNT
    );
    expect(txSig).toBeTruthy();

    // Verify balance decreased
    const balanceAfter = await getSplTokenBalance(ataA);
    expect(balanceAfter).toBe(balanceBefore - DEPOSIT_AMOUNT);

    // Verify on-chain deposit is recorded
    const state = await fetchChannelState(channelPDA);
    // Deposit is recorded under whichever participant slot A maps to
    // (depends on sort order of pubkeys)
    const totalDeposit = state.depositA + state.depositB;
    expect(totalDeposit).toBe(DEPOSIT_AMOUNT);
  });

  // =========================================================================
  // TEST: Ed25519 balance proof signs and verifies correctly
  // =========================================================================

  it('Ed25519 balance proof signs and verifies correctly', async () => {
    if (skipIfNotReady(solanaReady)) return;

    // Sign a balance proof: A says it has transferred TRANSFER_AMOUNT to B
    const signature = signBalanceProof(
      channelPDA,
      1n, // nonce
      TRANSFER_AMOUNT,
      participantA
    );

    // Verify the signature is 64 bytes (Ed25519)
    expect(signature).toBeInstanceOf(Uint8Array);
    expect(signature.length).toBe(64);

    // Verify locally using @noble/curves
    const message = buildBalanceProofMessage(channelPDA, 1n, TRANSFER_AMOUNT);
    expect(message.length).toBe(48);
    const isValid = ed25519.verify(signature, message, participantA.publicKey);
    expect(isValid).toBe(true);

    // Submit the claim on-chain (participant B claims using A's signature)
    // This verifies the Ed25519 signature via the precompile program
    const txSig = await claimFromChannel(
      participantB,
      channelPDA,
      programId,
      1n,
      TRANSFER_AMOUNT,
      signature
    );
    expect(txSig).toBeTruthy();

    // Verify on-chain nonce and transferred amount updated
    const state = await fetchChannelState(channelPDA);
    const totalTransferred = state.transferredAmountA + state.transferredAmountB;
    expect(totalTransferred).toBe(TRANSFER_AMOUNT);
  });

  // =========================================================================
  // TEST: Channel close and settlement lifecycle
  // =========================================================================

  it('channel close and settlement lifecycle', async () => {
    if (skipIfNotReady(solanaReady)) return;

    // 1. Close the channel (either participant can close)
    const closeTxSig = await closeChannel(participantA, channelPDA, programId);
    expect(closeTxSig).toBeTruthy();

    // Verify channel is now closed
    let state = await fetchChannelState(channelPDA);
    expect(state.state).toBe('closed');

    // 2. Wait for challenge period to expire.
    //    Solana test-validator auto-advances slots/time, so waiting
    //    real-world seconds is sufficient.
    const waitMs = (Number(CHALLENGE_DURATION) + 3) * 1000;
    await new Promise((r) => setTimeout(r, waitMs));

    // 3. Record pre-settlement token balances
    const balanceBeforeA = await getSplTokenBalance(ataA);
    const balanceBeforeB = await getSplTokenBalance(ataB);

    // 4. Settle the channel
    const settleTxSig = await settleChannel(
      participantA,
      channelPDA,
      ataA,
      ataB,
      participantA.pubkeyBase58, // rent recipient
      programId
    );
    expect(settleTxSig).toBeTruthy();

    // 5. Verify channel state = settled
    state = await fetchChannelState(channelPDA);
    expect(state.state).toBe('settled');

    // 6. Verify balance redistribution:
    //    A deposited DEPOSIT_AMOUNT, transferred TRANSFER_AMOUNT to B
    //    A gets back (DEPOSIT_AMOUNT - TRANSFER_AMOUNT) = 40000
    //    B gets TRANSFER_AMOUNT = 10000
    const balanceAfterA = await getSplTokenBalance(ataA);
    const balanceAfterB = await getSplTokenBalance(ataB);

    expect(balanceAfterA).toBe(balanceBeforeA + DEPOSIT_AMOUNT - TRANSFER_AMOUNT);
    expect(balanceAfterB).toBe(balanceBeforeB + TRANSFER_AMOUNT);
  });
});

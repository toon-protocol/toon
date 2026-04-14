/**
 * EVM-specific settlement tx construction + signature verification
 * (Story 12.6 AC-7).
 *
 * @module
 * @since 12.6
 * @see _bmad-output/implementation-artifacts/12-6-build-settlement-tx.md
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { SettlementTxError } from '../errors.js';
import type { AccumulatedClaim } from '../stream-swap.js';
import {
  balanceProofHashEvm,
  bigintToBytes32BE,
  concatBytes,
  hexToBytes,
} from './hashes.js';
import type { MillSignerConfig, SettlementBundle } from './types.js';

// ---------------------------------------------------------------------------
// Function selector + event signature
// ---------------------------------------------------------------------------

// TODO(12.6 follow-up): verify against the TokenNetwork contract in
// ../connector/packages/contracts/. Story 12.8 E2E will catch drift if the
// real contract uses a different name/arity.
const EVM_SETTLEMENT_FUNCTION_SIGNATURE =
  'updateBalance(bytes32,uint256,uint256,address,bytes)';
const EVM_SETTLEMENT_EVENT_SIGNATURE =
  'SettlementSucceeded(bytes32,uint256,uint256,address)';

/** 4-byte keccak256 function selector for the settlement call. */
export const EVM_SETTLEMENT_FUNCTION_SELECTOR: Uint8Array = keccak_256(
  new TextEncoder().encode(EVM_SETTLEMENT_FUNCTION_SIGNATURE)
).slice(0, 4);

const EVM_SETTLEMENT_EVENT_TOPIC: string =
  '0x' +
  bytesToHex(
    keccak_256(new TextEncoder().encode(EVM_SETTLEMENT_EVENT_SIGNATURE))
  );

// ---------------------------------------------------------------------------
// Recover EVM signer address
// ---------------------------------------------------------------------------

/**
 * Recover the EVM signer address from an `AccumulatedClaim`'s 65-byte
 * `r||s||v` signature. Returns lowercase `0x`-prefixed 40-hex-char address.
 *
 * Reconstructs the balance-proof message hash via `balanceProofHashEvm` using
 * the claim's settlement-context fields (channelId, cumulativeAmount, nonce,
 * recipient) and recovers the secp256k1 public key.
 *
 * @throws {SettlementTxError} INVALID_SIGNATURE_LENGTH / INVALID_SIGNATURE_V /
 *   MISSING_SETTLEMENT_METADATA.
 * @since 12.6
 */
export function recoverEvmSignerAddress(claim: AccumulatedClaim): string {
  if (
    claim.channelId === undefined ||
    claim.cumulativeAmount === undefined ||
    claim.nonce === undefined ||
    claim.recipient === undefined
  ) {
    throw new SettlementTxError(
      'MISSING_SETTLEMENT_METADATA',
      'Claim missing channelId/cumulativeAmount/nonce/recipient for EVM signer recovery'
    );
  }
  if (claim.claimBytes.length !== 65) {
    throw new SettlementTxError(
      'INVALID_SIGNATURE_LENGTH',
      `EVM signature must be 65 bytes (r||s||v), got ${claim.claimBytes.length}`
    );
  }
  const v = claim.claimBytes[64];
  if (v !== 27 && v !== 28) {
    throw new SettlementTxError(
      'INVALID_SIGNATURE_V',
      `EVM signature v must be 27 or 28, got ${v}`
    );
  }
  const recovery = v - 27;
  const compactRS = claim.claimBytes.slice(0, 64);

  let msgHash: Uint8Array;
  let uncompressedPubkey: Uint8Array;
  try {
    const channelIdBytes = hexToBytes(claim.channelId);
    const recipientBytes = hexToBytes(claim.recipient);
    if (channelIdBytes.length !== 32) {
      throw new Error(
        `channelId must be 32 bytes (got ${channelIdBytes.length})`
      );
    }
    if (recipientBytes.length !== 20) {
      throw new Error(
        `recipient must be 20 bytes (got ${recipientBytes.length})`
      );
    }
    msgHash = balanceProofHashEvm(
      channelIdBytes,
      BigInt(claim.cumulativeAmount),
      BigInt(claim.nonce),
      recipientBytes
    );
    const sig = secp256k1.Signature.fromBytes(
      compactRS,
      'compact'
    ).addRecoveryBit(recovery);
    const point = sig.recoverPublicKey(msgHash);
    uncompressedPubkey = point.toBytes(false);
  } catch (err) {
    throw new SettlementTxError(
      'ENCODING_FAILED',
      `EVM signer recovery failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }

  // Uncompressed pubkey is 65 bytes: 0x04 || X(32) || Y(32). Address =
  // last 20 bytes of keccak256(X||Y).
  const addrHash = keccak_256(uncompressedPubkey.slice(1));
  return '0x' + bytesToHex(addrHash.slice(-20)).toLowerCase();
}

// ---------------------------------------------------------------------------
// Minimal ABI encoder (bytes32, uint256, uint256, address, bytes)
// ---------------------------------------------------------------------------

function padLeft32(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 32) {
    throw new SettlementTxError(
      'ENCODING_FAILED',
      `cannot pad bytes of length ${bytes.length} to 32`
    );
  }
  const out = new Uint8Array(32);
  out.set(bytes, 32 - bytes.length);
  return out;
}

function padRight32(bytes: Uint8Array): Uint8Array {
  const padded = Math.ceil(bytes.length / 32) * 32;
  const out = new Uint8Array(padded);
  out.set(bytes, 0);
  return out;
}

function encodeUpdateBalanceCallData(
  channelIdBytes: Uint8Array,
  cumulativeAmount: bigint,
  nonce: bigint,
  recipientBytes: Uint8Array,
  signature: Uint8Array
): Uint8Array {
  if (channelIdBytes.length !== 32) {
    throw new SettlementTxError(
      'ENCODING_FAILED',
      `channelId must be 32 bytes (got ${channelIdBytes.length})`
    );
  }
  if (recipientBytes.length !== 20) {
    throw new SettlementTxError(
      'ENCODING_FAILED',
      `recipient must be 20 bytes (got ${recipientBytes.length})`
    );
  }

  // Solidity ABI layout for `(bytes32, uint256, uint256, address, bytes)`:
  //   head = channelId(32) || cumulative(32) || nonce(32) || recipient(32) || offset(32) = 160 bytes
  //   tail = sigLen(32) || sigPadded(ceil(sigLen/32)*32)
  // Only `bytes` is dynamic; its head slot is the offset (160) into the
  // head+tail region (selector is NOT counted in the offset per spec).
  const channelIdWord = channelIdBytes; // already 32
  const cumulativeWord = bigintToBytes32BE(cumulativeAmount);
  const nonceWord = bigintToBytes32BE(nonce);
  const recipientWord = padLeft32(recipientBytes);
  const offsetWord = bigintToBytes32BE(160n);
  const sigLenWord = bigintToBytes32BE(BigInt(signature.length));
  const sigPadded = padRight32(signature);

  return concatBytes(
    EVM_SETTLEMENT_FUNCTION_SELECTOR,
    channelIdWord,
    cumulativeWord,
    nonceWord,
    recipientWord,
    offsetWord,
    sigLenWord,
    sigPadded
  );
}

// ---------------------------------------------------------------------------
// Minimal RLP encoder (for EIP-155 unsigned tx)
// ---------------------------------------------------------------------------

function rlpEncodeBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 1 && bytes[0] !== undefined && bytes[0] < 0x80) {
    return bytes;
  }
  if (bytes.length < 56) {
    return concatBytes(new Uint8Array([0x80 + bytes.length]), bytes);
  }
  const lenBytes = bigintToMinimalBytes(BigInt(bytes.length));
  return concatBytes(new Uint8Array([0xb7 + lenBytes.length]), lenBytes, bytes);
}

function rlpEncodeList(items: Uint8Array[]): Uint8Array {
  const payload = concatBytes(...items);
  if (payload.length < 56) {
    return concatBytes(new Uint8Array([0xc0 + payload.length]), payload);
  }
  const lenBytes = bigintToMinimalBytes(BigInt(payload.length));
  return concatBytes(
    new Uint8Array([0xf7 + lenBytes.length]),
    lenBytes,
    payload
  );
}

function bigintToMinimalBytes(x: bigint): Uint8Array {
  if (x < 0n) {
    throw new SettlementTxError(
      'ENCODING_FAILED',
      'bigintToMinimalBytes: negative input'
    );
  }
  if (x === 0n) return new Uint8Array(0);
  let hex = x.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function rlpEncodeUint(x: bigint): Uint8Array {
  return rlpEncodeBytes(bigintToMinimalBytes(x));
}

/**
 * RLP-encode an EIP-155 unsigned transaction:
 *   [nonce, gasPrice, gasLimit, to, value, data, chainId, 0, 0]
 */
function rlpEncodeUnsignedTx(params: {
  nonce: bigint;
  gasPrice: bigint;
  gasLimit: bigint;
  to: Uint8Array; // 20 bytes
  value: bigint;
  data: Uint8Array;
  chainId: bigint;
}): Uint8Array {
  return rlpEncodeList([
    rlpEncodeUint(params.nonce),
    rlpEncodeUint(params.gasPrice),
    rlpEncodeUint(params.gasLimit),
    rlpEncodeBytes(params.to),
    rlpEncodeUint(params.value),
    rlpEncodeBytes(params.data),
    rlpEncodeUint(params.chainId),
    rlpEncodeUint(0n),
    rlpEncodeUint(0n),
  ]);
}

// ---------------------------------------------------------------------------
// buildEvmSettlementTx
// ---------------------------------------------------------------------------

/**
 * Produce a `SettlementBundle` for a winning EVM `AccumulatedClaim`.
 *
 * The bundle's `unsignedTxBytes` is RLP-encoded with placeholder gas fields
 * (tx-nonce / gasPrice / gasLimit = 0). Callers (direct sender OR a Chain
 * Bridge DVM) fill in real gas via {@link fillEvmSettlementTxGas} before
 * signing + broadcasting.
 *
 * @stable
 * @since 12.6
 */
export function buildEvmSettlementTx(
  winner: AccumulatedClaim,
  signer: MillSignerConfig,
  recipient: string,
  selectedClaimIndex: number,
  claimsMerged: number
): SettlementBundle {
  if (
    winner.channelId === undefined ||
    winner.cumulativeAmount === undefined ||
    winner.nonce === undefined ||
    winner.recipient === undefined ||
    winner.millSignerAddress === undefined
  ) {
    throw new SettlementTxError(
      'MISSING_SETTLEMENT_METADATA',
      'EVM winner claim missing settlement-context fields'
    );
  }
  if (!signer.contractAddress) {
    throw new SettlementTxError(
      'INVALID_INPUT',
      `EVM MillSignerConfig.contractAddress is required for chain ${winner.pair.to.chain}`
    );
  }
  if (
    typeof signer.chainId !== 'number' ||
    !Number.isInteger(signer.chainId) ||
    signer.chainId <= 0
  ) {
    throw new SettlementTxError(
      'INVALID_INPUT',
      `EVM MillSignerConfig.chainId must be a positive integer, got ${signer.chainId}`
    );
  }

  const channelIdBytes = hexToBytes(winner.channelId);
  const recipientBytes = hexToBytes(recipient);
  const contractBytes = hexToBytes(signer.contractAddress);

  const calldata = encodeUpdateBalanceCallData(
    channelIdBytes,
    BigInt(winner.cumulativeAmount),
    BigInt(winner.nonce),
    recipientBytes,
    winner.claimBytes
  );

  const unsignedTxBytes = rlpEncodeUnsignedTx({
    nonce: 0n,
    gasPrice: 0n,
    gasLimit: 0n,
    to: contractBytes,
    value: 0n,
    data: calldata,
    chainId: BigInt(signer.chainId),
  });

  return {
    chain: winner.pair.to.chain,
    chainKind: 'evm',
    channelId: winner.channelId,
    cumulativeAmount: winner.cumulativeAmount,
    nonce: winner.nonce,
    recipient,
    millSignerAddress: winner.millSignerAddress,
    unsignedTxBytes,
    expectedEventSignature: EVM_SETTLEMENT_EVENT_TOPIC,
    claimsMerged,
    selectedClaimIndex,
    sourceChain: winner.pair.from.chain,
    sourceAssetCode: winner.pair.from.assetCode,
  };
}

// ---------------------------------------------------------------------------
// fillEvmSettlementTxGas
// ---------------------------------------------------------------------------

/**
 * Re-encode an EVM settlement bundle's RLP with real tx-nonce / gasPrice /
 * gasLimit values. The `to`, `value`, `data`, `chainId` fields are preserved
 * from the original bundle.
 *
 * @stable
 * @since 12.6
 */
export function fillEvmSettlementTxGas(
  bundle: SettlementBundle,
  gas: { nonce: bigint; gasPrice: bigint; gasLimit: bigint },
  signer: MillSignerConfig
): Uint8Array {
  if (bundle.chainKind !== 'evm') {
    throw new SettlementTxError(
      'UNSUPPORTED_CHAIN',
      `fillEvmSettlementTxGas requires chainKind=evm, got ${bundle.chainKind}`
    );
  }
  if (!signer.contractAddress) {
    throw new SettlementTxError(
      'INVALID_INPUT',
      'EVM MillSignerConfig.contractAddress is required for gas-fill'
    );
  }
  if (typeof signer.chainId !== 'number' || signer.chainId <= 0) {
    throw new SettlementTxError(
      'INVALID_INPUT',
      'EVM MillSignerConfig.chainId must be a positive integer'
    );
  }
  // Decode calldata from the original bundle's RLP: we know calldata starts
  // at a fixed offset in our own encoding, but safer to re-construct from
  // bundle fields using encodeUpdateBalanceCallData again.
  const channelIdBytes = hexToBytes(bundle.channelId);
  const recipientBytes = hexToBytes(bundle.recipient);
  const contractBytes = hexToBytes(signer.contractAddress);
  // We need the 65-byte signature back; extract it from the original bundle's
  // calldata payload, which is the last `signature.length` bytes before the
  // zero-padding. Simplest: re-build from settlement fields alone cannot
  // reproduce the signature — so we require the caller to pass it via the
  // bundle's embedded claim. Instead of complicating the API, parse the
  // signature out of bundle.unsignedTxBytes calldata.
  const sig = extractSignatureFromBundle(bundle);
  const calldata = encodeUpdateBalanceCallData(
    channelIdBytes,
    BigInt(bundle.cumulativeAmount),
    BigInt(bundle.nonce),
    recipientBytes,
    sig
  );
  return rlpEncodeUnsignedTx({
    nonce: gas.nonce,
    gasPrice: gas.gasPrice,
    gasLimit: gas.gasLimit,
    to: contractBytes,
    value: 0n,
    data: calldata,
    chainId: BigInt(signer.chainId),
  });
}

/**
 * Decode the 65-byte balance-proof signature from a bundle's RLP-encoded
 * calldata. The calldata layout is:
 *   selector(4) || channelId(32) || cumulative(32) || nonce(32) ||
 *   recipient(32) || offset(32) || sigLen(32) || sigPadded(ceil(sigLen/32)*32)
 */
function extractSignatureFromBundle(bundle: SettlementBundle): Uint8Array {
  // We re-parse our own RLP encoding. For robustness, locate the data field
  // via a minimal RLP walk.
  const tx = bundle.unsignedTxBytes;
  const list = rlpDecodeList(tx);
  if (list.length < 6) {
    throw new SettlementTxError(
      'ENCODING_FAILED',
      'unsignedTxBytes is not a 9-element RLP list'
    );
  }
  const data = list[5];
  if (!data) {
    throw new SettlementTxError(
      'ENCODING_FAILED',
      'unsignedTxBytes missing data field'
    );
  }
  // data = selector(4) || head(5 * 32) || sigLen(32) || sigPadded
  const sigLenOffset = 4 + 5 * 32;
  if (data.length < sigLenOffset + 32) {
    throw new SettlementTxError(
      'ENCODING_FAILED',
      'calldata too short to contain signature length word'
    );
  }
  const sigLenBytes = data.slice(sigLenOffset, sigLenOffset + 32);
  let sigLen = 0n;
  for (const b of sigLenBytes) sigLen = (sigLen << 8n) | BigInt(b);
  const sigStart = sigLenOffset + 32;
  const sigEnd = sigStart + Number(sigLen);
  if (sigEnd > data.length) {
    throw new SettlementTxError(
      'ENCODING_FAILED',
      'calldata truncated before end of signature bytes'
    );
  }
  return data.slice(sigStart, sigEnd);
}

// Minimal RLP decoder (items as raw bytes; does NOT recurse into sublists).
function rlpDecodeList(buf: Uint8Array): Uint8Array[] {
  if (buf.length === 0) {
    throw new SettlementTxError('ENCODING_FAILED', 'empty RLP input');
  }
  const first = buf[0] ?? 0;
  let offset: number;
  let listEnd: number;
  if (first >= 0xc0 && first <= 0xf7) {
    offset = 1;
    listEnd = 1 + (first - 0xc0);
  } else if (first >= 0xf8 && first <= 0xff) {
    const lenOfLen = first - 0xf7;
    let listLen = 0;
    for (let i = 0; i < lenOfLen; i++) {
      listLen = (listLen << 8) | (buf[1 + i] ?? 0);
    }
    offset = 1 + lenOfLen;
    listEnd = offset + listLen;
  } else {
    throw new SettlementTxError(
      'ENCODING_FAILED',
      `rlpDecodeList: input is not a list (first byte 0x${first.toString(16)})`
    );
  }
  const items: Uint8Array[] = [];
  let p = offset;
  while (p < listEnd) {
    const b = buf[p] ?? 0;
    if (b < 0x80) {
      items.push(buf.slice(p, p + 1));
      p += 1;
    } else if (b <= 0xb7) {
      const len = b - 0x80;
      items.push(buf.slice(p + 1, p + 1 + len));
      p += 1 + len;
    } else if (b <= 0xbf) {
      const lenOfLen = b - 0xb7;
      let len = 0;
      for (let i = 0; i < lenOfLen; i++) {
        len = (len << 8) | (buf[p + 1 + i] ?? 0);
      }
      items.push(buf.slice(p + 1 + lenOfLen, p + 1 + lenOfLen + len));
      p += 1 + lenOfLen + len;
    } else {
      throw new SettlementTxError(
        'ENCODING_FAILED',
        'rlpDecodeList: nested list not supported in minimal decoder'
      );
    }
  }
  return items;
}

/**
 * Verify an EVM claim's signature by recovering the signer and comparing to
 * `expectedAddress`. Returns `{ valid, recovered }`.
 *
 * @since 12.6
 */
export function verifyEvmClaimSignature(
  claim: AccumulatedClaim,
  expectedAddress: string
): { valid: boolean; recovered: string } {
  const recovered = recoverEvmSignerAddress(claim);
  const expected = expectedAddress.toLowerCase();
  return {
    valid: recovered.toLowerCase() === expected,
    recovered,
  };
}

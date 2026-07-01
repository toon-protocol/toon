// One-shot EVM→Solana mill swap exercised through the running toon-clientd
// daemon. Builds the NIP-59 gift-wrapped kind:20032 swap rumor here (the SDK's
// wrapSwapPacketToToon), then sends it via the daemon /swap toonData passthrough
// so the daemon signs the source-asset claim against the open apex EVM channel.
// FULFILL carries the NIP-44-encrypted target-chain (Solana) claim.
import {
  wrapSwapPacketToToon,
  decryptFulfillClaim,
} from '../dist/index.js';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { webcrypto } from 'node:crypto';

const DAEMON = 'http://127.0.0.1:8787';
const MILL_ILP = 'g.proxy.mill';
const MILL_PUBKEY =
  '7e05a33203ad3d164312239b0124d27fd670ee36560e72f6807dba0a0e33858a';
const CHAIN_RECIPIENT = '2VVaZGFQQ4fFVnTM1AE6uCkADbgMfaBgAzLvJJ7Jsed5'; // Solana payout

// Operator-provided pair (kind:10032 not on relay yet — hard-coded per #197):
// EVM USDC (evm:base:84532) → Solana USDC (solana:devnet) rate 1.0 min 1000 max 1e9
const pair = {
  from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:84532' },
  to: { assetCode: 'USDC', assetScale: 6, chain: 'solana:devnet' },
  rate: '1.0',
  minAmount: '1000',
  maxAmount: '1000000000',
};

const sourceAmount = 1000n; // min packet, single packet
const sk = generateSecretKey();
const senderPubkey = getPublicKey(sk);

const nonce = new Uint8Array(16);
webcrypto.getRandomValues(nonce);

const rumor = {
  kind: 20032,
  pubkey: senderPubkey,
  content: '',
  created_at: Math.floor(Date.now() / 1000),
  tags: [
    ['swap-from', `${pair.from.assetCode}:${pair.from.chain}`],
    ['swap-to', `${pair.to.assetCode}:${pair.to.chain}`],
    ['amount', sourceAmount.toString()],
    ['seq', '1', '1'],
    ['nonce', Buffer.from(nonce).toString('hex')],
    ['chain-recipient', CHAIN_RECIPIENT],
  ],
};

const wrapped = wrapSwapPacketToToon({
  rumor,
  senderSecretKey: sk,
  recipientPubkey: MILL_PUBKEY,
  destination: MILL_ILP,
  amount: sourceAmount,
});
const toonDataB64 = wrapped.ilpPrepare.data; // already base64

console.log(
  `swap rumor kind:20032 sender ${senderPubkey.slice(0, 16)}… → mill ${MILL_PUBKEY.slice(0, 16)}…`
);
console.log(
  `pair USDC:evm:base:84532 → USDC:solana:devnet  amount ${sourceAmount} (micro)  recipient ${CHAIN_RECIPIENT}`
);

const res = await fetch(`${DAEMON}/swap`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    destination: MILL_ILP,
    amount: sourceAmount.toString(),
    toonData: toonDataB64,
  }),
});

const body = await res.json().catch(() => ({}));
console.log(`HTTP ${res.status}`);
console.log(JSON.stringify(body, null, 2));

if (body && body.accepted && body.data) {
  // FULFILL data = base64 JSON metadata { claim, ephemeralPubkey, ... }
  try {
    const meta = JSON.parse(Buffer.from(body.data, 'base64').toString('utf8'));
    console.log('FULFILL metadata keys:', Object.keys(meta));
    console.log(
      'settlement:',
      JSON.stringify(
        {
          channelId: meta.channelId,
          nonce: meta.nonce,
          cumulativeAmount: meta.cumulativeAmount,
          recipient: meta.recipient,
          millSignerAddress: meta.millSignerAddress,
          targetAmount: meta.targetAmount,
          claimId: meta.claimId,
        },
        null,
        2
      )
    );
    if (meta.claim && meta.ephemeralPubkey) {
      const claimBytes = decryptFulfillClaim({
        ciphertext: new Uint8Array(Buffer.from(meta.claim, 'base64')),
        ephemeralPubkey: meta.ephemeralPubkey,
        recipientSecretKey: sk,
      });
      console.log(
        `decrypted target-chain claim: ${claimBytes.length} bytes (Solana USDC claim)`
      );
    }
  } catch (e) {
    console.log('FULFILL decode note:', e.message);
  }
}
process.exit(res.ok && body.accepted ? 0 : 1);

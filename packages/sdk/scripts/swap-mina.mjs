// One-shot EVM→Mina swap through the running toon-clientd daemon.
// Same gift-wrap-then-/swap-passthrough flow as swap.mjs, target = Mina.
// First Mina swap triggers the swap's one-time PaymentChannel.compile() (~30s).
import {
  wrapSwapPacketToToon,
  decryptFulfillClaim,
} from '../dist/index.js';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { webcrypto } from 'node:crypto';

const DAEMON = 'http://127.0.0.1:8787';
const SWAP_ILP = 'g.proxy.swap';
const SWAP_PUBKEY =
  '7e05a33203ad3d164312239b0124d27fd670ee36560e72f6807dba0a0e33858a';
const CHAIN_RECIPIENT = 'B62qjBemthF5md3g9nS27Q96Tkaz5bKCkGUEwrFo5cy41VpoCmpfz7J'; // daemon Mina addr

// Operator pair: EVM USDC (evm:base:84532) → MINA (mina:devnet) rate 1.0 min 1000 max 1e9
const pair = {
  from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:84532' },
  to: { assetCode: 'MINA', assetScale: 9, chain: 'mina:devnet' },
  rate: '1.0',
  minAmount: '1000',
  maxAmount: '1000000000',
};

const sourceAmount = 1000n;

async function attempt(n) {
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
    recipientPubkey: SWAP_PUBKEY,
    destination: SWAP_ILP,
    amount: sourceAmount,
  });

  console.log(
    `\n[attempt ${n}] swap rumor kind:20032 sender ${senderPubkey.slice(0, 12)}… → swap, USDC:evm:base:84532 → MINA:mina:devnet, amount ${sourceAmount}, recipient ${CHAIN_RECIPIENT.slice(0, 14)}…`
  );

  const res = await fetch(`${DAEMON}/swap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      destination: SWAP_ILP,
      amount: sourceAmount.toString(),
      toonData: wrapped.ilpPrepare.data,
    }),
  });
  const body = await res.json().catch(() => ({}));
  console.log(`HTTP ${res.status}`, JSON.stringify(body).slice(0, 200));

  if (res.ok && body.accepted && body.data) {
    const meta = JSON.parse(Buffer.from(body.data, 'base64').toString('utf8'));
    console.log(
      'settlement:',
      JSON.stringify(
        {
          channelId: meta.channelId,
          nonce: meta.nonce,
          cumulativeAmount: meta.cumulativeAmount,
          recipient: meta.recipient,
          swapSignerAddress: meta.swapSignerAddress,
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
      console.log(`decrypted target-chain claim: ${claimBytes.length} bytes (Mina claim)`);
    }
    return true;
  }
  return false;
}

// First attempt may time out during the ~30s compile; retry once on a warm swap.
let ok = await attempt(1);
if (!ok) {
  console.log('\nfirst attempt did not FULFILL (likely the ~30s compile) — retrying on warm swap…');
  ok = await attempt(2);
}
process.exit(ok ? 0 : 1);

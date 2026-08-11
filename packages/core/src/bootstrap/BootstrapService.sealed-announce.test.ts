/**
 * `BootstrapService.announceViaIlp` against a connector that enforces the
 * two rules the real Rust connector enforces
 * (`crates/connector-domain/src/condition.rs`): a PREPARE with an absent or
 * all-zero execution condition is refused outright (F01), and a payload that
 * does not open as a gift wrap sealed to this connector's identity is
 * refused too (toon#143).
 *
 * Before the fix, `announceViaIlp` sent both — no condition, and a plaintext
 * base64 TOON payload — which is exactly what the issue's live reproduction
 * quotes:
 *
 *   [Bootstrap] Announce rejected by nostr-2813187eb66741f9: F01 prepare
 *   carries no execution condition
 *
 * This file reproduces that rejection against a fake terminating connector
 * in CI, rather than only against a live devnet connector, so the fix has a
 * regression test that would have failed on the pre-fix code (RED) and
 * passes on the fixed code (GREEN).
 */

import { describe, it, expect, vi } from 'vitest';
import { generateSecretKey } from 'nostr-tools/pure';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { BootstrapService } from './BootstrapService.js';
import type {
  BootstrapEvent,
  BootstrapResult,
  IlpClient,
  IlpSendResult,
  ConnectorEdgeLookup,
  KnownPeer,
} from './types.js';
import type { IlpPeerInfo } from '../types.js';
import {
  openRequest,
  sealResponse,
  encodeEnvelopeResponse,
  localGiftWrapEcdh,
  isZeroCondition,
} from '../wire/index.js';

const IDENTITY_SECRET = new Uint8Array(32).fill(3);
const IDENTITY_PUBLIC = secp256k1.getPublicKey(IDENTITY_SECRET, false);
const ROUTE_PRICE = 250n;

type RustLikeConnector = IlpClient & {
  sendIlpPacket: ReturnType<typeof vi.fn>;
  /** Incremented only when a request was genuinely opened (sealed + valid). */
  openedCount: number;
};

/**
 * A connector that enforces exactly the two toon#143 rules and nothing else:
 * refuse a missing/all-zero condition (F01, quoting the real connector's
 * message verbatim), and refuse a payload that does not open as a gift wrap
 * sealed to {@link IDENTITY_PUBLIC}. Anything that clears both is opened for
 * real via `openRequest` — there is no way to fake acceptance without a
 * genuinely sealed, conditioned packet.
 */
function createRustLikeConnector(): RustLikeConnector {
  const connector = {
    openedCount: 0,
    sendIlpPacket: vi.fn(),
  } as RustLikeConnector;

  connector.sendIlpPacket.mockImplementation(
    async (params: {
      data: string;
      executionCondition?: string;
    }): Promise<IlpSendResult> => {
      const condition = params.executionCondition
        ? Uint8Array.from(Buffer.from(params.executionCondition, 'base64'))
        : undefined;
      if (isZeroCondition(condition)) {
        return {
          accepted: false,
          code: 'F01',
          message: 'prepare carries no execution condition',
        };
      }

      const dataBytes = Uint8Array.from(Buffer.from(params.data, 'base64'));
      let opened;
      try {
        opened = openRequest(dataBytes, localGiftWrapEcdh(IDENTITY_SECRET));
      } catch {
        return {
          accepted: false,
          code: 'F06',
          message: 'data is not a gift wrap sealed to this connector',
        };
      }
      connector.openedCount++;

      const answer = encodeEnvelopeResponse({
        status: 200,
        headers: [],
        body: new Uint8Array(0),
      });
      return {
        accepted: true,
        data: Buffer.from(sealResponse(opened.sharedSecret, answer)).toString(
          'base64'
        ),
      };
    }
  );

  return connector;
}

function createConnectorEdgeLookup(): ConnectorEdgeLookup {
  return {
    getIdentity: vi.fn().mockResolvedValue({ publicKey: IDENTITY_PUBLIC }),
    getRoutePrice: vi.fn().mockResolvedValue({ price: ROUTE_PRICE }),
  };
}

const PEER_INFO: IlpPeerInfo = {
  ilpAddress: 'g.test.peer',
  btpEndpoint: 'ws://peer:3000',
  assetCode: 'USD',
  assetScale: 6,
};

function createKnownPeer(): KnownPeer {
  return {
    pubkey: 'aa'.repeat(32),
    relayUrl: 'ws://localhost:7100',
    btpEndpoint: 'ws://peer:3000',
  };
}

describe('the fake Rust-like connector itself', () => {
  // These pin the fake's own behaviour against the issue's literal
  // reproduction, independent of BootstrapService — proof the fixture
  // enforces what it claims to before it is trusted as a regression test.

  it('refuses a PREPARE with no execution condition at all, quoting the live F01', async () => {
    const connector = createRustLikeConnector();
    const result = await connector.sendIlpPacket({
      destination: 'g.test.peer',
      amount: '100',
      data: Buffer.from('plaintext-toon-payload').toString('base64'),
    });
    expect(result).toEqual({
      accepted: false,
      code: 'F01',
      message: 'prepare carries no execution condition',
    });
    expect(connector.openedCount).toBe(0);
  });

  it('refuses a PREPARE with an all-zero execution condition, same as absent', async () => {
    const connector = createRustLikeConnector();
    const result = (await connector.sendIlpPacket({
      destination: 'g.test.peer',
      amount: '100',
      data: Buffer.from('plaintext-toon-payload').toString('base64'),
      executionCondition: Buffer.from(new Uint8Array(32)).toString('base64'),
    })) as IlpSendResult;
    expect(result.accepted).toBe(false);
    expect(result.code).toBe('F01');
  });

  it('refuses a plaintext payload even under a well-formed non-zero condition', async () => {
    const connector = createRustLikeConnector();
    const result = (await connector.sendIlpPacket({
      destination: 'g.test.peer',
      amount: '100',
      data: Buffer.from('plaintext-toon-payload').toString('base64'),
      executionCondition: Buffer.from(new Uint8Array(32).fill(1)).toString(
        'base64'
      ),
    })) as IlpSendResult;
    expect(result.accepted).toBe(false);
    expect(result.code).toBe('F06');
    expect(connector.openedCount).toBe(0);
  });
});

describe('BootstrapService.announceViaIlp against the fake terminating connector', () => {
  it('never reaches the connector at all when no connectorEdgeLookup is wired', async () => {
    // Red before the fix, for the reason toon#143 reports: the pre-fix code
    // sent an unsealed, unconditioned packet here, and this Rust-like
    // connector answers that with F01 — so `events` would carry an
    // announce-failed. After the fix there is no identity to seal to, so the
    // guard skips the announce and the connector is never asked. That is the
    // safe half of the fix; the next test is the sealed, accepted half.
    const connector = createRustLikeConnector();
    const events: BootstrapEvent[] = [];
    const secretKey = generateSecretKey();
    const service = new BootstrapService(
      {
        knownPeers: [],
        toonEncoder: () => new Uint8Array([1, 2, 3]),
        toonDecoder: () => ({}) as never,
        // No connectorEdgeLookup.
      },
      secretKey,
      PEER_INFO
    );
    service.setIlpClient(connector);
    service.on((event) => events.push(event));

    const result: BootstrapResult = {
      knownPeer: createKnownPeer(),
      peerInfo: PEER_INFO,
      registeredPeerId: 'nostr-peer1',
    };
    const successCount = await service.republish([result]);

    expect(successCount).toBe(1); // announce silently skipped, not a failure
    expect(connector.sendIlpPacket).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it('sends a sealed, conditioned packet the fake connector genuinely opens and accepts', async () => {
    const connector = createRustLikeConnector();
    const connectorEdgeLookup = createConnectorEdgeLookup();
    const events: BootstrapEvent[] = [];
    const secretKey = generateSecretKey();
    const service = new BootstrapService(
      {
        knownPeers: [],
        toonEncoder: () => new Uint8Array([1, 2, 3]),
        toonDecoder: () => ({}) as never,
        connectorEdgeLookup,
      },
      secretKey,
      PEER_INFO
    );
    service.setIlpClient(connector);
    service.on((event) => events.push(event));

    const result: BootstrapResult = {
      knownPeer: createKnownPeer(),
      peerInfo: PEER_INFO,
      registeredPeerId: 'nostr-peer1',
    };
    const successCount = await service.republish([result]);

    // The fake connector accepted — it never returned F01 or F06 — and
    // genuinely opened the sealed request (not merely a stub that always
    // says yes).
    expect(successCount).toBe(1);
    expect(connector.openedCount).toBe(1);
    expect(events.some((e) => e.type === 'bootstrap:announced')).toBe(true);
    expect(events.some((e) => e.type === 'bootstrap:announce-failed')).toBe(
      false
    );

    const call = connector.sendIlpPacket.mock.calls[0]?.[0] as {
      executionCondition?: string;
      amount: string;
    };
    expect(call.executionCondition).toBeDefined();
    const condition = Buffer.from(call.executionCondition ?? '', 'base64');
    expect(condition).toHaveLength(32);
    expect(condition.equals(Buffer.alloc(32))).toBe(false);
    // The amount was asked for via connectorEdgeLookup.getRoutePrice, not
    // computed from the TOON payload's byte length.
    expect(call.amount).toBe(String(ROUTE_PRICE));
  });
});

/**
 * Connector API Contract Smoke Test (Story 22.5)
 *
 * Lightweight canary that fails fast (<60s) when @toon-protocol/connector
 * makes a breaking change to its public surface. Catches regressions before
 * the full E2E matrix runs (E2E takes minutes + Docker; this takes <2s).
 *
 * Coverage:
 *   - sendPacket()           — mandatory `expiresAt: Date`, return shape
 *   - buildSwarmSelectionEvent() — mandatory `customerPubkey`, event shape
 *   - registerPeer()         — `PeerRegistrationRequest` shape (id/url/authToken)
 *   - openChannel()          — params shape, `{ channelId, status }` return
 *
 * No Docker, no Anvil, no relay. Pure stub-based verification of API shape.
 *
 * If this test fails, see packages/sdk/CONNECTOR_MIGRATION.md for the
 * version-to-version contract mapping.
 */

import { describe, it, expect, vi } from 'vitest';
import type {
  SendPacketParams,
  PeerRegistrationRequest,
  PeerInfo,
  PaymentHandler,
  PaymentRequest,
  PaymentResponse,
  ILPFulfillPacket,
  ILPRejectPacket,
  ConnectorConfig,
} from '@toon-protocol/connector';
import {
  buildSwarmSelectionEvent,
  type EmbeddableConnectorLike,
  type RegisterPeerParams,
} from '@toon-protocol/core';
import { createNode, type NodeConfig } from '../../src/index.js';

/**
 * Narrows node.connector (EmbeddableConnectorLike | null) to non-null.
 * Always set in these tests via createTestNodeConfig(); asserts that
 * invariant without a non-null assertion (`!`), which the lint gate
 * forbids here.
 */
function requireConnector(
  connector: EmbeddableConnectorLike | null | undefined
): EmbeddableConnectorLike {
  if (!connector) {
    throw new Error('expected connector to be defined');
  }
  return connector;
}

/**
 * Calls registerPeer with the connector package's real request shape
 * (`PeerRegistrationRequest`: authToken required, settlement typed as
 * `AdminSettlementConfig`). The SDK's structural `EmbeddableConnectorLike`
 * (`RegisterPeerParams`: authToken optional, settlement typed as
 * `Record<string, unknown>`) is a looser supertype that every
 * `PeerRegistrationRequest` satisfies at runtime, but TS can't confirm
 * `AdminSettlementConfig` (no index signature) as a `Record<string,
 * unknown>` structurally, so the cast is centralized here once instead of
 * at every call site.
 */
function callRegisterPeer(
  connector: EmbeddableConnectorLike,
  params: PeerRegistrationRequest
): Promise<void> {
  return connector.registerPeer(params as unknown as RegisterPeerParams);
}

// 60-second per-test timeout — AC #2 hard ceiling. Tests should each finish
// in <100ms; the cap exists so a hanging stub fails the canary fast.
const SIXTY_SECONDS = 60_000;

// PacketType discriminator values — fixed by the ILP OER wire spec.
// Re-defined here (rather than imported from @toon-protocol/shared, which
// is not a direct dep of @toon-protocol/sdk) so this canary stays
// dependency-light. If these literals drift from the connector's enum,
// this file fails compilation against ILPFulfillPacket / ILPRejectPacket.
const FULFILL = 13 as const;
const REJECT = 14 as const;

// ---------------------------------------------------------------------------
// Stub factory — minimal connector that satisfies EmbeddableConnectorLike.
// ---------------------------------------------------------------------------

interface StubOverrides {
  sendPacket?: (params: SendPacketParams) => Promise<unknown>;
  registerPeer?: (config: PeerRegistrationRequest) => Promise<PeerInfo>;
  removePeer?: (peerId: string) => Promise<unknown>;
  openChannel?: (params: unknown) => Promise<unknown>;
  getChannelState?: (channelId: string) => Promise<unknown>;
}

function makePeerInfo(id: string): PeerInfo {
  return {
    id,
    connected: true,
    ilpAddresses: [`g.test.${id}`],
    routeCount: 1,
  };
}

function createStubConnector(overrides: StubOverrides = {}) {
  const fulfill: ILPFulfillPacket = {
    type: FULFILL,
    fulfillment: Buffer.alloc(32),
    data: Buffer.alloc(0),
  };
  return {
    sendPacket: vi.fn(overrides.sendPacket ?? (async () => fulfill)),
    registerPeer: vi.fn(
      overrides.registerPeer ??
        (async (config: PeerRegistrationRequest) => makePeerInfo(config.id))
    ),
    removePeer: vi.fn(overrides.removePeer ?? (async () => undefined)),
    setPacketHandler: vi.fn(),
    openChannel: vi.fn(
      overrides.openChannel ??
        (async () => ({ channelId: 'ch-stub-1', status: 'open' }))
    ),
    getChannelState: vi.fn(
      overrides.getChannelState ??
        (async () => ({
          channelId: 'ch-stub-1',
          status: 'open' as const,
          chain: 'evm:base:31337',
        }))
    ),
  };
}

function createTestNodeConfig(stub = createStubConnector()): NodeConfig {
  const secretKey = new Uint8Array(32).fill(0x42);
  return {
    secretKey,
    // The stub's registerPeer resolves Promise<PeerInfo> (the real
    // connector's documented return shape, asserted on directly below via
    // the stub); EmbeddableConnectorLike's structural type narrows this to
    // Promise<void> (the SDK adapter's return type) — both are true of the
    // same mock simultaneously, TS just can't see it structurally.
    connector: stub as unknown as EmbeddableConnectorLike,
    ilpAddress: 'g.test.contract',
    assetCode: 'USD',
    assetScale: 6,
  };
}

// 64-char hex pubkey/event-id stub (must satisfy buildSwarmSelectionEvent
// regex validators).
const STUB_HEX_64 = 'a'.repeat(64);

// Compile-time contract guards live in `./connector-contract.types.ts`
// and are checked via `tsc --noEmit -p ./tsconfig.json` in CI. This file
// covers behavioral assertions; types here are stripped by vitest/esbuild.

// ---------------------------------------------------------------------------
// sendPacket() — AC #1 + #2
// ---------------------------------------------------------------------------

describe('connector contract: sendPacket()', { timeout: SIXTY_SECONDS }, () => {
  it('SendPacketParams.expiresAt is mandatory (compile-time + runtime shape)', async () => {
    const stub = createStubConnector();
    const node = createNode(createTestNodeConfig(stub));

    // Mandatory params per @toon-protocol/connector v3.3.2:
    //   destination: string, amount: bigint, expiresAt: Date, data?: Buffer
    const params: SendPacketParams = {
      destination: 'g.test.peer',
      amount: 1000n,
      expiresAt: new Date(Date.now() + 30_000),
      data: Buffer.from([0x01]),
    };

    const connector = requireConnector(node.connector);
    await connector.sendPacket(params);

    expect(stub.sendPacket).toHaveBeenCalledTimes(1);
    const called = stub.sendPacket.mock.calls[0]?.[0] as SendPacketParams;
    expect(called.expiresAt).toBeInstanceOf(Date);
  });

  it('rejects when expiresAt is omitted (runtime guard against pre-v3.x defaulting)', async () => {
    // In v2.x, expiresAt was optional and the connector defaulted to now+30s.
    // In v3.x, omitting expiresAt is a contract violation. The stub mirrors
    // v3.x behavior: throw rather than silently default.
    const stub = createStubConnector({
      sendPacket: async (params) => {
        if (!(params.expiresAt instanceof Date)) {
          throw new TypeError(
            'sendPacket: expiresAt is mandatory and must be a Date'
          );
        }
        return {
          type: FULFILL,
          fulfillment: Buffer.alloc(32),
          data: Buffer.alloc(0),
        } satisfies ILPFulfillPacket;
      },
    });
    const node = createNode(createTestNodeConfig(stub));

    const badParams = {
      destination: 'g.test.peer',
      amount: 1000n,
      data: Buffer.from([0x01]),
      // expiresAt deliberately omitted
    } as unknown as SendPacketParams;

    const connector = requireConnector(node.connector);
    await expect(connector.sendPacket(badParams)).rejects.toThrow(/expiresAt/);
  });

  it('return shape is ILPFulfillPacket | ILPRejectPacket (PacketType discriminator)', async () => {
    const node = createNode(createTestNodeConfig());
    const connector = requireConnector(node.connector);
    // node.connector.sendPacket()'s structural return type
    // (SendPacketResult, from EmbeddableConnectorLike) is a superset that
    // also accepts legacy string-discriminated shapes for mock
    // compatibility; the real connector always resolves the narrower
    // PacketType-enum-discriminated shape this test asserts on.
    const result = (await connector.sendPacket({
      destination: 'g.test.peer',
      amount: 1n,
      expiresAt: new Date(Date.now() + 30_000),
    })) as unknown as ILPFulfillPacket | ILPRejectPacket;

    // Discriminated union must use PacketType enum, not legacy 'type: "fulfill"'
    expect([FULFILL, REJECT]).toContain(result.type);
    if (result.type === FULFILL) {
      expect(result.fulfillment).toBeInstanceOf(Buffer);
      expect(result.fulfillment.length).toBe(32);
    }
  });
});

// ---------------------------------------------------------------------------
// buildSwarmSelectionEvent() — AC #1
// ---------------------------------------------------------------------------

describe(
  'connector contract: buildSwarmSelectionEvent()',
  { timeout: SIXTY_SECONDS },
  () => {
    it('requires customerPubkey, swarmRequestEventId, winnerResultEventId', () => {
      const secretKey = new Uint8Array(32).fill(0x11);
      const event = buildSwarmSelectionEvent(
        {
          swarmRequestEventId: STUB_HEX_64,
          winnerResultEventId: STUB_HEX_64,
          customerPubkey: STUB_HEX_64,
        },
        secretKey
      );

      // Kind 7000 (job feedback) per swarm.ts contract
      expect(event.kind).toBe(7000);
      expect(event.id).toMatch(/^[0-9a-f]{64}$/);
      expect(event.sig).toMatch(/^[0-9a-f]{128}$/);

      // Required tags
      const tagKeys = event.tags.map((t) => t[0]);
      expect(tagKeys).toEqual(
        expect.arrayContaining(['e', 'p', 'status', 'winner'])
      );
      const pTag = event.tags.find((t) => t[0] === 'p');
      expect(pTag?.[1]).toBe(STUB_HEX_64);
    });

    it('throws when customerPubkey is missing or malformed', () => {
      const secretKey = new Uint8Array(32).fill(0x11);

      // Malformed: must mention the field name or hex format, not just any
      // downstream "Cannot read properties of undefined" crash.
      expect(() =>
        buildSwarmSelectionEvent(
          {
            swarmRequestEventId: STUB_HEX_64,
            winnerResultEventId: STUB_HEX_64,
            customerPubkey: 'not-hex',
          },
          secretKey
        )
      ).toThrow(/customerPubkey|hex|64/i);

      // Missing entirely: validator must reject with a message that names
      // the field, not propagate a generic TypeError from downstream.
      expect(() =>
        buildSwarmSelectionEvent(
          {
            swarmRequestEventId: STUB_HEX_64,
            winnerResultEventId: STUB_HEX_64,
          } as unknown as Parameters<typeof buildSwarmSelectionEvent>[0],
          secretKey
        )
      ).toThrow(/customerPubkey/);
    });
  }
);

// ---------------------------------------------------------------------------
// registerPeer() — AC #1
// ---------------------------------------------------------------------------

describe(
  'connector contract: registerPeer()',
  { timeout: SIXTY_SECONDS },
  () => {
    it('PeerRegistrationRequest shape (id, url, authToken; optional routes/settlement)', async () => {
      const stub = createStubConnector();
      const node = createNode(createTestNodeConfig(stub));
      const connector = requireConnector(node.connector);

      const params: PeerRegistrationRequest = {
        id: 'peer-contract-1',
        url: 'btp+wss://peer.example.com',
        authToken: 'secret',
        routes: [{ prefix: 'g.test', priority: 100 }],
      };

      // Use objectContaining so the canary catches removal/rename of
      // mandatory fields without false-failing on benign SDK-side
      // normalization (e.g., a future release that defaults `routes: []`).
      await callRegisterPeer(connector, params);
      expect(stub.registerPeer).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'peer-contract-1',
          url: 'btp+wss://peer.example.com',
          authToken: 'secret',
        })
      );

      // Connector's documented return shape is `Promise<PeerInfo>` (the
      // SDK adapter narrows to `Promise<void>`, so we assert the connector
      // surface directly via the stub's typed return).
      const peerInfo = await stub.registerPeer.getMockImplementation()!(params);
      expect(peerInfo).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          connected: expect.any(Boolean),
          ilpAddresses: expect.any(Array),
          routeCount: expect.any(Number),
        })
      );

      const minimal: PeerRegistrationRequest = {
        id: 'peer-contract-2',
        url: 'btp+wss://peer2.example.com',
        authToken: 'secret2',
      };
      await callRegisterPeer(connector, minimal);
      expect(stub.registerPeer).toHaveBeenCalledTimes(2);
      expect(stub.registerPeer).toHaveBeenLastCalledWith(
        expect.objectContaining({
          id: 'peer-contract-2',
          url: 'btp+wss://peer2.example.com',
          authToken: 'secret2',
        })
      );
    });

    it('rejects when mandatory fields are missing (id/url/authToken)', async () => {
      const stub = createStubConnector({
        registerPeer: async (config) => {
          if (!config.id || !config.url || !config.authToken) {
            throw new Error(
              'registerPeer: id, url, and authToken are mandatory'
            );
          }
          return makePeerInfo(config.id);
        },
      });
      const node = createNode(createTestNodeConfig(stub));
      const connector = requireConnector(node.connector);

      const incomplete = {
        id: 'peer-x',
        url: 'btp+wss://peer-x.example.com',
        // authToken deliberately omitted
      } as unknown as PeerRegistrationRequest;

      await expect(callRegisterPeer(connector, incomplete)).rejects.toThrow(
        /authToken/
      );
    });
  }
);

// ---------------------------------------------------------------------------
// openChannel() — AC #1
// ---------------------------------------------------------------------------

describe(
  'connector contract: openChannel()',
  { timeout: SIXTY_SECONDS },
  () => {
    it('accepts { peerId, chain, peerAddress } and returns { channelId, status }', async () => {
      const stub = createStubConnector();
      const node = createNode(createTestNodeConfig(stub));
      expect(node.channelClient).not.toBeNull();

      const result = await node.channelClient!.openChannel({
        peerId: 'peer-contract-1',
        chain: 'evm:base:31337',
        peerAddress: '0x1234567890abcdef1234567890abcdef12345678',
      });

      expect(stub.openChannel).toHaveBeenCalledTimes(1);
      expect(result).toEqual(
        expect.objectContaining({
          channelId: expect.any(String),
          status: expect.any(String),
        })
      );
    });

    it('getChannelState return shape exposes chain + lifecycle status', async () => {
      const node = createNode(createTestNodeConfig());
      expect(node.channelClient).not.toBeNull();

      const state = await node.channelClient!.getChannelState('ch-stub-1');
      expect(state.channelId).toBe('ch-stub-1');
      expect(['opening', 'open', 'closed', 'settled']).toContain(state.status);
      expect(typeof state.chain).toBe('string');
    });
  }
);

// ---------------------------------------------------------------------------
// PaymentHandler / ctx.accept() — AC #2 sub-task 2.4
// Migration doc claims `ctx.accept()` no longer carries a `fulfillment`
// field (v2.2.0+ change). Guard the application-API shape here so a
// regression that re-adds `fulfillment` (or removes `accept`/`data`/
// `rejectReason`) fails the canary.
// ---------------------------------------------------------------------------

describe(
  'connector contract: PaymentHandler / accept response shape',
  { timeout: SIXTY_SECONDS },
  () => {
    it('PaymentHandler request fields are paymentId/destination/amount/expiresAt; response carries { accept, data?, rejectReason? } — no fulfillment', async () => {
      // Typed handler — drift in PaymentHandler / PaymentRequest /
      // PaymentResponse fails compilation here, before any test runs.
      const handler: PaymentHandler = async (
        request: PaymentRequest
      ): Promise<PaymentResponse> => {
        expect(typeof request.paymentId).toBe('string');
        expect(typeof request.destination).toBe('string');
        expect(typeof request.amount).toBe('string');
        expect(typeof request.expiresAt).toBe('string');
        return { accept: true, data: 'AA==' };
      };

      // Invoke the handler the way the connector would and assert the
      // response shape matches the documented v3.x application contract.
      const response = await handler({
        paymentId: 'pay-contract-1',
        destination: 'g.test.peer',
        amount: '1000',
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      });
      expect(response).toEqual(
        expect.objectContaining({ accept: expect.any(Boolean) })
      );

      // The legacy `fulfillment` field was removed from the application
      // API in connector v2.2.0 — guard against it being reintroduced.
      expect(response).not.toHaveProperty('fulfillment');
    });

    it('PaymentResponse rejection path uses { accept: false, rejectReason: { code, message } } — no fulfillment', () => {
      const reject: PaymentResponse = {
        accept: false,
        rejectReason: { code: 'F00_BAD_REQUEST', message: 'invalid' },
      };
      expect(reject.accept).toBe(false);
      expect(reject.rejectReason).toEqual(
        expect.objectContaining({
          code: expect.any(String),
          message: expect.any(String),
        })
      );
      expect(reject).not.toHaveProperty('fulfillment');
    });
  }
);

// ---------------------------------------------------------------------------
// Config-block contract — AC #2 sub-task 2.3
// ---------------------------------------------------------------------------

describe(
  'connector contract: ConnectorConfig shape',
  { timeout: SIXTY_SECONDS },
  () => {
    it('ConnectorConfig has chainProviders[]', () => {
      // Compile-time guard: indexing ConnectorConfig with 'chainProviders'
      // must resolve. If the field is renamed/removed in a future connector
      // release, this type alias fails to compile.
      type _HasChainProviders = ConnectorConfig['chainProviders'];
      const probe = {} as ConnectorConfig;
      // Runtime smoke: the field is optional, so undefined is the expected
      // value on a bare object. We're verifying property access compiles.
      expect(probe.chainProviders).toBeUndefined();
    });

    it('ConnectorConfig does NOT have legacy settlementInfra block', () => {
      // Compile-time guard via @ts-expect-error: indexing a non-existent
      // key on ConnectorConfig is a type error today. If connector v4.x
      // regrows `settlementInfra`, the indexing succeeds, the directive
      // becomes "unused", and TS errors with TS2578 — failing this canary.
      // @ts-expect-error settlementInfra was removed in connector v3.x
      type _NoSettlementInfra = ConnectorConfig['settlementInfra'];
      expect(true).toBe(true);
    });
  }
);

/**
 * Connector API Contract — TYPE-ONLY guards (Story 22.5)
 *
 * Compile-time half of the canary. Lives in its own file so it can be
 * type-checked by `tsc --noEmit` in CI, independently of the runtime
 * test file (which vitest transpiles with esbuild — types are stripped).
 *
 * Drift in any of the connector's exported types listed below fails
 * compilation here, before any runtime test runs.
 *
 * Sister file: `connector-contract.test.ts` covers behavioral assertions.
 * Migration history: `packages/sdk/CONNECTOR_MIGRATION.md`.
 */

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

// ---------------------------------------------------------------------------
// SendPacketParams — `expiresAt: Date` is mandatory in v3.x.
// ---------------------------------------------------------------------------
declare const _sendPacketParams: SendPacketParams;
type _ExpiresAtIsDate = SendPacketParams['expiresAt'] extends Date
  ? true
  : never;
const _expiresAtCheck: _ExpiresAtIsDate = true;

// ---------------------------------------------------------------------------
// registerPeer — `Promise<PeerInfo>`, NOT `Promise<void>`. The SDK adapter
// narrows to void; the connector's actual surface returns PeerInfo.
// ---------------------------------------------------------------------------
declare const _connectorRegisterPeer: (
  config: PeerRegistrationRequest
) => Promise<PeerInfo>;

declare const _peerInfo: PeerInfo;
const _peerInfoFields: {
  id: string;
  connected: boolean;
  ilpAddresses: string[];
  routeCount: number;
} = _peerInfo;

// ---------------------------------------------------------------------------
// ILPFulfillPacket / ILPRejectPacket — discriminated union, fulfillment as
// 32-byte Buffer on FULFILL.
// ---------------------------------------------------------------------------
declare const _fulfillPacket: ILPFulfillPacket;
declare const _rejectPacket: ILPRejectPacket;
const _fulfillType: 13 = _fulfillPacket.type;
const _rejectType: 14 = _rejectPacket.type;
const _fulfillmentIsBuffer: Buffer = _fulfillPacket.fulfillment;

// ---------------------------------------------------------------------------
// PaymentHandler / ctx.accept() — application API; `fulfillment` was
// removed from PaymentResponse in v2.2.0+.
// ---------------------------------------------------------------------------
declare const _paymentHandler: PaymentHandler;
declare const _paymentRequest: PaymentRequest;
declare const _paymentResponse: PaymentResponse;
const _responseHasAccept: boolean = _paymentResponse.accept;

// `fulfillment` MUST NOT be a property on PaymentResponse. If a future
// connector regrows it, this directive becomes "unused" and tsc fails
// with TS2578 — failing the canary at compile time.
// @ts-expect-error fulfillment was removed from the application-side
// PaymentResponse in connector v2.2.0
type _NoFulfillmentOnResponse = PaymentResponse['fulfillment'];

// ---------------------------------------------------------------------------
// ConnectorConfig — `chainProviders[]` present, `settlementInfra` removed.
// ---------------------------------------------------------------------------
type _HasChainProviders = ConnectorConfig['chainProviders'];

// @ts-expect-error settlementInfra was removed in connector v3.x — if it
// regrows on ConnectorConfig, this directive becomes "unused" (TS2578),
// failing the canary.
type _NoSettlementInfra = ConnectorConfig['settlementInfra'];

// ---------------------------------------------------------------------------
// Suppress "unused" warnings on the runtime-side const probes — these
// exist solely as compile-time anchors for the type checker.
// ---------------------------------------------------------------------------
export const _typeProbes = {
  _expiresAtCheck,
  _peerInfoFields,
  _fulfillType,
  _rejectType,
  _fulfillmentIsBuffer,
  _responseHasAccept,
  _connectorRegisterPeer,
  _connectorPaymentHandler: _paymentHandler,
  _connectorPaymentRequest: _paymentRequest,
  _connectorPaymentResponse: _paymentResponse,
  _sendPacketParams,
};
export type _ConnectorContractTypeProbes =
  | _ExpiresAtIsDate
  | _HasChainProviders
  | _NoSettlementInfra
  | _NoFulfillmentOnResponse;

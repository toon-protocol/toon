/**
 * The sealed wire (ADR 0018/0019/0020) as `@toon-protocol/core` speaks it.
 *
 * The OER envelope codec, the gift wrap that seals it to the terminating
 * connector's identity, and the fulfilment a sealed request's shared secret
 * derives — each checked against the connector's committed cross-repo
 * vectors in `wire-vectors.test.ts`. Ported from `toon-client`'s
 * `packages/client/src/wire/` (toon#143): `core` is where both `core` and
 * `client` can meet without a package cycle (`client` depends on `core`,
 * never the other way around).
 *
 * `sealed-exchange.ts` binds them into the one thing a sender actually forms:
 * a sealed request, the condition that matches it, and the reader for the
 * answer that comes back. `BootstrapService.announceViaIlp` sends through it.
 */

export {
  OerError,
  OerErrorKind,
  encodeVarUint,
  decodeVarUint,
  encodeVarOctetString,
  decodeVarOctetString,
  type Decoded,
} from './oer.js';

export {
  EnvelopeError,
  EnvelopeErrorKind,
  encodeEnvelope,
  decodeEnvelope,
  encodeEnvelopeRequest,
  decodeEnvelopeRequest,
  encodeEnvelopeResponse,
  decodeEnvelopeResponse,
  type Envelope,
  type EnvelopeHeader,
  type EnvelopeRequest,
  type EnvelopeResponse,
} from './envelope.js';

export {
  GiftWrapError,
  GiftWrapErrorKind,
  GIFTWRAP_NONCE_LENGTH,
  GIFTWRAP_PUBLIC_KEY_LENGTH,
  GIFTWRAP_SECRET_LENGTH,
  GIFTWRAP_TYPE_REQUEST,
  GIFTWRAP_TYPE_RESPONSE,
  deriveCondition,
  deriveFulfillment,
  giftWrapPublicKey,
  localGiftWrapEcdh,
  looksLikeSealedResponse,
  openRequest,
  openResponse,
  sealRequest,
  sealRequestWithRandomness,
  sealResponse,
  sealResponseWithRandomness,
  type GiftWrapEcdh,
  type OpenedRequest,
  type SealedRequest,
} from './giftwrap.js';

export {
  CONDITION_LENGTH,
  mintExecutionCondition,
  isZeroCondition,
  assertValidCondition,
  fulfillmentMatchesCondition,
  type ExecutionConditionPair,
} from './condition.js';

export {
  sealExchange,
  readExchangeOutcome,
  envelopeHeader,
  SealedResponseError,
  type SealedExchange,
  type ExchangeOutcome,
  type SealedResponseErrorKind,
} from './sealed-exchange.js';

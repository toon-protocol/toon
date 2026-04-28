/**
 * ILP wire-code → connector semantic-reason translation.
 *
 * Connector v3.3.2 changed the contract: its payment-handler adapter
 * (`payment-handler.js`'s `mapRejectCode()`) takes a SEMANTIC reason key
 * (e.g. `'internal_error'`) and looks it up in `REJECT_CODE_MAP` to produce
 * the wire code (`'T00'`). If a caller passes a raw wire code (`'T00'`) it
 * is not a key in the map, so the connector falls back to the generic
 * `'F99'` code — collapsing every reject reason regardless of its true
 * cause.
 *
 * The TOON SDK / handlers express rejections via `ctx.reject(ilpCode, msg)`
 * using ILP wire codes (T00, F00, F03, F04, F06, T04, R00, ...). This
 * helper inverts the connector's `REJECT_CODE_MAP` so callers can translate
 * back to the semantic key the connector now expects.
 *
 * Source of truth for the connector's accepted keys:
 *   `@toon-protocol/connector` v3.3.2 — `core/payment-handler.js`'s
 *   `REJECT_CODE_MAP` (insufficient_funds, expired, invalid_request,
 *    invalid_amount, unexpected_payment, application_error, internal_error,
 *    timeout).
 */

/**
 * Inverse of the connector's `REJECT_CODE_MAP`.
 *
 * Maps every ILP wire code the SDK currently emits to a semantic reason
 * the connector recognises. Codes outside this set fall back to
 * `'invalid_request'` (`'F00'`) so we still produce a meaningful,
 * non-`F99` wire code at the far side.
 *
 * Note: F04 (invalid destination address / pricing-related) has no exact
 * semantic counterpart; we map it to `'invalid_request'` to stay within
 * the F-class.
 */
export const ILP_TO_SEMANTIC: Readonly<Record<string, string>> = Object.freeze({
  T00: 'internal_error',
  T04: 'insufficient_funds',
  F00: 'invalid_request',
  F03: 'invalid_amount',
  F04: 'invalid_request', // No exact semantic match; F04 is pricing-related
  F06: 'unexpected_payment',
  R00: 'expired',
});

/**
 * Translate an ILP wire code (T00, F00, ...) to the semantic reason the
 * connector's `mapRejectCode()` expects. Falls back to `'invalid_request'`
 * for unknown codes — yields `'F00'` at the wire instead of the generic
 * `'F99'`.
 */
export function ilpCodeToSemantic(ilpCode: string): string {
  return ILP_TO_SEMANTIC[ilpCode] ?? 'invalid_request';
}

import { describe, it, expect } from 'vitest';
import { ILP_TO_SEMANTIC, ilpCodeToSemantic } from './reject-code.js';

/**
 * The connector's `REJECT_CODE_MAP` (semantic reason -> ILP wire code), copied
 * verbatim from `@toon-protocol/connector` core/payment-handler.ts. This is the
 * authority for which semantic reasons the connector accepts and what wire code
 * each re-encodes to. Our `ILP_TO_SEMANTIC` is the inverse direction (wire code
 * -> semantic reason); every value it produces MUST be a key here, otherwise the
 * connector falls back to the generic F99.
 */
const CONNECTOR_REJECT_CODE_MAP: Readonly<Record<string, string>> = {
  insufficient_funds: 'T04',
  expired: 'R00',
  unreachable: 'F02',
  invalid_request: 'F00',
  invalid_amount: 'F03',
  insufficient_destination_amount: 'F04',
  unexpected_payment: 'F06',
  application_error: 'F99',
  internal_error: 'T00',
  timeout: 'T00',
};

describe('ilpCodeToSemantic / ILP_TO_SEMANTIC', () => {
  it('every mapped semantic reason is one the connector accepts (no silent F99)', () => {
    for (const [ilpCode, semantic] of Object.entries(ILP_TO_SEMANTIC)) {
      expect(
        CONNECTOR_REJECT_CODE_MAP[semantic],
        `wire code ${ilpCode} -> semantic "${semantic}" is not in the connector REJECT_CODE_MAP`
      ).toBeDefined();
    }
  });

  it('maps every code the swap handler emits (issue #86 regression)', () => {
    // packages/sdk/src/swap-handler.ts emits exactly these wire codes.
    const swapHandlerCodes = ['F01', 'F02', 'F04', 'F06', 'T00', 'T04'];
    for (const code of swapHandlerCodes) {
      expect(
        ILP_TO_SEMANTIC[code],
        `swap handler emits ${code} but it is not explicitly mapped`
      ).toBeDefined();
    }
  });

  it('F01 normalizes to invalid_request (-> wire F00), explicitly and not via fallback (#86)', () => {
    // The connector vocabulary has no F01; F01 ("Invalid gift wrap" /
    // "Invalid amount") is intentionally normalized to invalid_request.
    expect(ILP_TO_SEMANTIC['F01']).toBe('invalid_request');
    expect(ilpCodeToSemantic('F01')).toBe('invalid_request');
    expect(CONNECTOR_REJECT_CODE_MAP['invalid_request']).toBe('F00');
  });

  it('round-trips known codes back to their own wire code where a 1:1 exists', () => {
    // For codes whose semantic maps back to the same wire code, the round trip
    // is lossless. (F01 is intentionally lossy F01 -> F00, asserted above.)
    const lossless = ['T00', 'T04', 'F00', 'F02', 'F03', 'F04', 'F06', 'R00'];
    for (const code of lossless) {
      const semantic = ilpCodeToSemantic(code);
      expect(CONNECTOR_REJECT_CODE_MAP[semantic]).toBe(code);
    }
  });

  it('falls back to invalid_request for unknown codes', () => {
    expect(ilpCodeToSemantic('F99')).toBe('invalid_request');
    expect(ilpCodeToSemantic('ZZZ')).toBe('invalid_request');
  });
});

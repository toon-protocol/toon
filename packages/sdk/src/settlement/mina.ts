/**
 * Mina stub (Story 12.6 AC-9).
 *
 * Mina settlement requires the `mina-signer` optional peer dep + zkApp wiring
 * and is deferred to an Epic 12 Story 12.8 follow-up.
 *
 * @module
 * @since 12.6
 */

import { SettlementTxError } from '../errors.js';
import type { AccumulatedClaim } from '../stream-swap.js';
import type { MillSignerConfig, SettlementBundle } from './types.js';

/**
 * Throws `SettlementTxError('UNSUPPORTED_CHAIN', ...)`. Mina settlement is out
 * of scope for Story 12.6.
 *
 * @since 12.6
 */
export function buildMinaSettlementTx(
  _winner: AccumulatedClaim,
  _signer: MillSignerConfig,
  _recipient: string,
  _selectedClaimIndex: number,
  _claimsMerged: number
): SettlementBundle {
  throw new SettlementTxError(
    'UNSUPPORTED_CHAIN',
    'Mina settlement requires mina-signer peer dep + zkApp wiring — deferred to Epic 12 Story 12.8 follow-up'
  );
}

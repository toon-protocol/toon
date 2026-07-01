/**
 * StoreHealthResponse — canonical type for the Store BLS health endpoint.
 * Exported from @toon-protocol/sdk so the node and the entrypoint share
 * the same definition (mirrors MillHealthResponse from @toon-protocol/mill).
 */

/** Per-kind job count for jobsRecent.byKind */
export interface StoreJobsByKindEntry {
  kind: number;
  count: number;
}

/** Per-status job counts for the sliding window */
export interface StoreJobsByStatus {
  processing: number;
  success: number;
  error: number;
  partial: number;
}

/** Windowed recent-jobs telemetry (default window: 5 min) */
export interface StoreJobsRecent {
  total: number;
  byKind: StoreJobsByKindEntry[];
  byStatus: StoreJobsByStatus;
}

/** Response shape for GET /health on the Store BLS server (port 3400). */
export interface StoreHealthResponse {
  status: 'starting' | 'ok' | 'stopping' | 'stopped' | 'error';
  version: string;
  nodePubkey: string;
  uptimeSec: number;
  /** Registered handler event kinds (e.g. [5094, 5250]). */
  handlerKinds: number[];
  /** Per-kind pricing in string-encoded bigint (e.g. { "5094": "10", "5250": "10000" }). */
  kindPricing: Record<string, string>;
  basePricePerByte: string;
  jobsRecent: StoreJobsRecent;
}

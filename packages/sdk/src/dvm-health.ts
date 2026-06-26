/**
 * DvmHealthResponse — canonical type for the DVM BLS health endpoint.
 * Exported from @toon-protocol/sdk so the node and the entrypoint share
 * the same definition (mirrors MillHealthResponse from @toon-protocol/mill).
 */

/** Per-kind job count for jobsRecent.byKind */
export interface DvmJobsByKindEntry {
  kind: number;
  count: number;
}

/** Per-status job counts for the sliding window */
export interface DvmJobsByStatus {
  processing: number;
  success: number;
  error: number;
  partial: number;
}

/** Windowed recent-jobs telemetry (default window: 5 min) */
export interface DvmJobsRecent {
  total: number;
  byKind: DvmJobsByKindEntry[];
  byStatus: DvmJobsByStatus;
}

/** Response shape for GET /health on the DVM BLS server (port 3400). */
export interface DvmHealthResponse {
  status: 'starting' | 'ok' | 'stopping' | 'stopped' | 'error';
  version: string;
  nodePubkey: string;
  uptimeSec: number;
  /** Registered handler event kinds (e.g. [5094, 5250]). */
  handlerKinds: number[];
  /** Per-kind pricing in string-encoded bigint (e.g. { "5094": "10", "5250": "10000" }). */
  kindPricing: Record<string, string>;
  basePricePerByte: string;
  jobsRecent: DvmJobsRecent;
}

/**
 * Adaptive δ/W controller for rolling swaps (issue #83, rolling-swap spec §6).
 *
 * Two knobs, managed separately:
 * - `δ` (delta) — packet size in source micro-units — bounds *per-packet
 *   pick-off risk*.
 * - `W` (window) — max unfulfilled packets in flight — bounds *timing /
 *   liveness risk* and the worst-case unrecovered exposure `δ·W`.
 *
 * Normative behavior implemented here (spec §6):
 * - **The cap.** `delta_cap = ε / (v·τ)`, recomputed per packet from measured
 *   state, and `δ ≤ delta_cap` always. δ and `delta_cap` are fractions of the
 *   session's remaining notional; `v·τ` is the expected fractional rate drift
 *   while one packet is in flight; ε is the per-packet slippage budget as a
 *   fraction of the maker's advertised half-spread (default `ε = 0.5 ×
 *   halfSpread`). ε is spread-denominated, never an absolute rate.
 * - **Inputs are measured, not trusted.** `v` is an EWMA of
 *   `abs(R_i − R_{i−1})/R_{i−1}` per second read off the quote tape
 *   (`PacketProgress.rate` / `rateTimestamp`, issue #82); `τ` is an EWMA of
 *   observed round-trip times. Both update on every observed packet.
 * - **Asymmetric adjustment, one knob per step.** On a shrink signal (a
 *   `stale_rate` reject, any other reject/verification failure, or realized
 *   per-packet slip `> ε`): multiplicative — `δ ← max(δ_min, δ/2)`; if the
 *   signal was a timeout/expiry, `W ← max(1, ⌈W/2⌉)` instead. On a clean
 *   streak of `K = 16` consecutive fulfills: additive — `δ ← min(caps, δ +
 *   δ_0)` or `W ← min(W_max, W + 1)`, alternating, never both in one step.
 * - **Cold start ramps.** With no persisted state for the tuple:
 *   `δ_0 = min(delta_cap, notional/256, maker maxAmount)`, `W_0 = 1`. Until
 *   the first shrink signal ever observed for the tuple, the δ widen step is
 *   multiplicative (`δ ← min(caps, 2δ)` per clean streak) — slow-start —
 *   dropping to additive permanently after the first loss event.
 * - **State is per-(chain, maker, pair) and persisted** via a pluggable
 *   {@link SwapControllerStateStore} (the SDK is isomorphic; the JSON-file
 *   implementation is Node-only and lazily imports `node:fs`).
 *
 * INVARIANT (spec §5): the controller is an *efficiency* mechanism only. It
 * never sees, computes, or relaxes the `minExchangeRate` floor — the floor
 * check in `stream-swap.ts` runs before the controller observes anything and
 * consults nothing but the floor itself. A calm (or adversarially painted)
 * tape can widen δ up to the caps, but can never worsen the sender's declared
 * worst case. NOTE: the adversarial-quote-tape question (toon-meta#146 — a
 * maker quoting calm to coax δ wide, then gapping one large packet) is open;
 * its resolution may tighten the cap logic here. The floor plus the absolute
 * `maxPacketAmount` cap are the uncompromising backstops in the meantime.
 *
 * @module
 */

import type { SwapPair } from '@toon-protocol/core';
import { ToonError } from '@toon-protocol/core';

import { applyRate } from './swap-handler.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Error thrown for invalid adaptive-controller configuration or a
 * persistence-layer failure surfaced through {@link SwapControllerStateStore}.
 */
export class SwapControllerError extends ToonError {
  constructor(message: string, cause?: Error) {
    super(message, 'SWAP_CONTROLLER_ERROR', cause);
    this.name = 'SwapControllerError';
  }
}

// ---------------------------------------------------------------------------
// Persisted state
// ---------------------------------------------------------------------------

/**
 * Persisted per-(chain, maker, pair) controller state (spec §6 value shape
 * `{delta, W, vEwma, tauEwma, cleanStreak, everShrunk, updatedAt}` plus the
 * additive `lastWidened` alternation marker).
 *
 * JSON-serializable by construction: `delta` is a decimal string because
 * `bigint` does not survive `JSON.stringify`.
 */
export interface SwapControllerState {
  /** Schema version for forward migration. Currently `1`. */
  v: 1;
  /**
   * Current ramp value of δ in source micro-units (decimal string).
   * `'0'` means "not yet initialized" — the first `nextDelta()` call seeds it
   * with the cold-start `δ_0`.
   */
  delta: string;
  /** In-flight window W: max unfulfilled packets outstanding. Always ≥ 1. */
  W: number;
  /** EWMA of `abs(ΔR)/R` per second, measured from the quote tape. */
  vEwma: number;
  /** EWMA of observed packet round-trip time, in seconds. */
  tauEwma: number;
  /** Consecutive clean fulfills since the last knob adjustment. */
  cleanStreak: number;
  /**
   * True once ANY shrink signal has ever been observed for this tuple.
   * Ends the multiplicative slow-start widen ramp permanently (spec §6).
   */
  everShrunk: boolean;
  /** Which knob the most recent widen step adjusted (alternation marker). */
  lastWidened: 'delta' | 'window';
  /** Unix ms of the last state mutation. */
  updatedAt: number;
}

const DECIMAL_UINT_REGEX = /^(0|[1-9]\d*)$/;

/** Runtime shape check for a (possibly foreign) persisted state blob. */
export function isSwapControllerState(
  value: unknown
): value is SwapControllerState {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  return (
    s['v'] === 1 &&
    typeof s['delta'] === 'string' &&
    DECIMAL_UINT_REGEX.test(s['delta'] as string) &&
    typeof s['W'] === 'number' &&
    Number.isInteger(s['W']) &&
    (s['W'] as number) >= 1 &&
    typeof s['vEwma'] === 'number' &&
    Number.isFinite(s['vEwma']) &&
    (s['vEwma'] as number) >= 0 &&
    typeof s['tauEwma'] === 'number' &&
    Number.isFinite(s['tauEwma']) &&
    (s['tauEwma'] as number) >= 0 &&
    typeof s['cleanStreak'] === 'number' &&
    Number.isInteger(s['cleanStreak']) &&
    (s['cleanStreak'] as number) >= 0 &&
    typeof s['everShrunk'] === 'boolean' &&
    (s['lastWidened'] === 'delta' || s['lastWidened'] === 'window') &&
    typeof s['updatedAt'] === 'number'
  );
}

/**
 * Canonical persistence key for a controller tuple (spec §6):
 * `${chain}:${makerPubkey}:${from}:${to}` with `from`/`to` as
 * `assetCode@chain` so cross-chain pairs sharing an asset code stay distinct.
 *
 * The leading `chain` segment is the SOURCE chain — per-tuple state is how
 * the same code runs fast on Base and cautious on Mina.
 */
export function swapControllerStateKey(params: {
  makerPubkey: string;
  pair: SwapPair;
}): string {
  const { makerPubkey, pair } = params;
  const from = `${pair.from.assetCode}@${pair.from.chain}`;
  const to = `${pair.to.assetCode}@${pair.to.chain}`;
  return `${pair.from.chain}:${makerPubkey}:${from}:${to}`;
}

// ---------------------------------------------------------------------------
// Pluggable state store
// ---------------------------------------------------------------------------

/**
 * Pluggable persistence seam for controller state, keyed by
 * {@link swapControllerStateKey}. The SDK is isomorphic, so the interface is
 * environment-neutral (same pattern as `WorkflowEventStore`); pick
 * {@link JsonFileSwapControllerStateStore} on Node or supply your own
 * (e.g. IndexedDB / daemon-side store in toon-client).
 */
export interface SwapControllerStateStore {
  load(key: string): Promise<SwapControllerState | undefined>;
  save(key: string, state: SwapControllerState): Promise<void>;
}

/** Volatile in-memory store — the default when no store is configured. */
export class InMemorySwapControllerStateStore implements SwapControllerStateStore {
  private readonly states = new Map<string, SwapControllerState>();

  async load(key: string): Promise<SwapControllerState | undefined> {
    const hit = this.states.get(key);
    return hit === undefined ? undefined : { ...hit };
  }

  async save(key: string, state: SwapControllerState): Promise<void> {
    this.states.set(key, { ...state });
  }
}

/**
 * Node-only JSON-file store (the toon-client `JsonFileChannelStore` pattern —
 * controller state persists beside the channel store). One JSON file holds a
 * `{ [key]: SwapControllerState }` map; writes are atomic
 * (temp-file + rename). `node:fs` / `node:path` are imported lazily so
 * bundling this module for the browser stays safe as long as the class is
 * not instantiated there.
 */
export class JsonFileSwapControllerStateStore implements SwapControllerStateStore {
  constructor(private readonly filePath: string) {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new SwapControllerError(
        'JsonFileSwapControllerStateStore requires a non-empty filePath'
      );
    }
  }

  private async readAll(): Promise<Record<string, unknown>> {
    const fs = await import('node:fs/promises');
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new SwapControllerError(
        `Failed to read controller state file ${this.filePath}`,
        err instanceof Error ? err : undefined
      );
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Corrupt file → treat as empty (cold start) rather than bricking every
      // future swap on this box. The next save rewrites it whole.
    }
    return {};
  }

  async load(key: string): Promise<SwapControllerState | undefined> {
    const all = await this.readAll();
    const candidate = all[key];
    return isSwapControllerState(candidate) ? { ...candidate } : undefined;
  }

  async save(key: string, state: SwapControllerState): Promise<void> {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const all = await this.readAll();
    all[key] = { ...state };
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(all, null, 2), 'utf8');
    await fs.rename(tmp, this.filePath);
  }
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

/**
 * Resolution class of one packet, as measured by the sender (spec §6):
 *
 * - `'fulfill'` — packet fulfilled and its claim accepted. Clean unless the
 *   realized slip exceeds ε (computed internally from `rate` +
 *   `sourceAmount` + `targetAmount`), in which case it is a shrink signal.
 * - `'reject-stale'` — maker staleness reject (`T99 stale_rate`, spec §4).
 *   Shrink signal → δ halves.
 * - `'reject'` — any other reject or verification failure (R5-class: floor
 *   breach, recipient substitution, bad claim). Shrink signal → δ halves.
 * - `'timeout'` — packet expiry / transport timeout. Shrink signal → W
 *   halves (timing risk, not pricing risk).
 * - `'error'` — transport or decode error. Shrink signal → δ halves.
 */
export type PacketResolution =
  | 'fulfill'
  | 'reject-stale'
  | 'reject'
  | 'timeout'
  | 'error';

/** One per-packet observation fed to {@link AdaptiveDeltaController.observe}. */
export interface PacketObservation {
  /** Resolution class for this packet (see {@link PacketResolution}). */
  resolution: PacketResolution;
  /** Measured round-trip time for this packet in ms (send → resolve). */
  rttMs?: number;
  /** Quote-tape rate `R_i` for this packet (decimal string, issue #82). */
  rate?: string;
  /** Unix ms when the maker's rate source produced {@link rate}. */
  rateTimestamp?: number;
  /** Source amount sent for this packet (micro-units). Used for slip. */
  sourceAmount?: bigint;
  /** Delivered target amount (micro-units). Used for slip. */
  targetAmount?: bigint;
  /**
   * Remaining session notional AFTER this packet (source micro-units).
   * When provided, widen steps are additionally clamped to the current
   * `delta_cap` fraction of it (spec §6 `δ ← min(delta_cap, δ + δ_0)`).
   * `nextDelta()` re-enforces the cap at issuance regardless.
   */
  remaining?: bigint;
}

// ---------------------------------------------------------------------------
// The controller
// ---------------------------------------------------------------------------

/**
 * The seam `streamSwap` consumes (kept structural so alternative controller
 * implementations — or a test double — can be plugged in).
 */
export interface StreamSwapAdaptiveController {
  /**
   * Decide the size of the next packet, in source micro-units, given the
   * session's remaining notional. MUST return a value in `[1, remaining]`
   * (callers clamp defensively). Enforces `δ ≤ delta_cap` at issuance.
   */
  nextDelta(remaining: bigint): bigint;
  /** Current in-flight window W (max unfulfilled packets outstanding, ≥ 1). */
  readonly window: number;
  /** Feed one packet observation. May persist state (hence async). */
  observe(observation: PacketObservation): void | Promise<void>;
}

/** Configuration for {@link AdaptiveDeltaController.create}. */
export interface AdaptiveDeltaControllerConfig {
  /** Maker's 64-char hex pubkey — part of the persistence key. */
  makerPubkey: string;
  /** The pair being executed — chain + asset parts of the persistence key. */
  pair: SwapPair;
  /**
   * Maker's advertised two-sided spread as a fraction (e.g. `0.004` = 40 bps).
   * ε is denominated off this — NEVER an absolute rate (spec §6): the
   * half-spread self-calibrates ε per chain and per maker. Today the spread
   * is caller-supplied (from the maker's board / RFQ response once toon#145's
   * RFQ lands); there is deliberately no default — an invented spread would
   * rot and silently mis-size ε.
   */
  advertisedSpread: number;
  /**
   * ε as a fraction of the advertised HALF-spread. Default `0.5`
   * (spec §6 default `ε = 0.5 × halfSpread`).
   */
  epsilonHalfSpreadFraction?: number;
  /**
   * Absolute per-packet ceiling in source micro-units (the maker's advertised
   * `maxAmount`). Applied to δ at issuance AND to every widen step — the
   * uncompromising absolute cap alongside the measured `v·τ` bound.
   */
  maxPacketAmount?: bigint;
  /** Floor on δ in source micro-units (`δ_min`). Default `1n`. */
  minPacketAmount?: bigint;
  /** Ceiling on W (`W_max`). Default `8`. */
  maxWindow?: number;
  /** Clean-fulfill streak length K per widen step. Default `16` (spec §6). */
  cleanStreakLength?: number;
  /**
   * Cold-start divisor: `δ_0 = notional / coldStartDivisor` (further clamped
   * by `delta_cap` and `maxPacketAmount`). Default `256` (spec §6).
   */
  coldStartDivisor?: number;
  /** EWMA smoothing factor α for both `v` and `τ`, in (0, 1]. Default `0.2`. */
  ewmaAlpha?: number;
  /**
   * Pluggable persistence. Default: a fresh volatile
   * {@link InMemorySwapControllerStateStore} (state survives the session
   * only). Pass {@link JsonFileSwapControllerStateStore} (Node) or a custom
   * store to persist ramp/trust across swaps.
   */
  store?: SwapControllerStateStore;
  /** Injectable clock for deterministic tests. Default `Date.now`. */
  now?: () => number;
}

const DEFAULT_EPSILON_HALF_SPREAD_FRACTION = 0.5;
const DEFAULT_MAX_WINDOW = 8;
const DEFAULT_CLEAN_STREAK_LENGTH = 16;
const DEFAULT_COLD_START_DIVISOR = 256;
const DEFAULT_EWMA_ALPHA = 0.2;
/** Fixed-point scale for applying the fractional delta_cap to a bigint. */
const CAP_SCALE = 1_000_000_000_000n; // 1e12
const CAP_SCALE_NUM = 1e12;

/** Parse a positive decimal-string rate to a JS number (measurement-grade). */
function rateToNumber(rate: string): number {
  const n = Number(rate);
  return Number.isFinite(n) && n > 0 ? n : NaN;
}

/**
 * Per-(chain, maker, pair) adaptive δ/W controller (spec §6). Construct via
 * {@link AdaptiveDeltaController.create} (async: loads persisted state).
 *
 * Concurrency note: one instance drives one swap session. Running two
 * concurrent sessions against the same tuple is last-write-wins on the
 * persisted state (same as concurrent channel use).
 */
export class AdaptiveDeltaController implements StreamSwapAdaptiveController {
  /** Persistence key for this tuple (see {@link swapControllerStateKey}). */
  readonly key: string;

  private readonly store: SwapControllerStateStore;
  private readonly pair: SwapPair;
  private readonly epsilon: number;
  private readonly maxPacketAmount: bigint | undefined;
  private readonly minPacketAmount: bigint;
  private readonly maxWindow: number;
  private readonly cleanStreakLength: number;
  private readonly coldStartDivisor: bigint;
  private readonly alpha: number;
  private readonly now: () => number;

  private readonly stateInternal: SwapControllerState;
  /** δ in-memory as bigint (mirrors `stateInternal.delta`). */
  private delta: bigint;
  /** Cold-start δ_0 — also the additive widen increment. Set on first nextDelta(). */
  private delta0: bigint | null = null;
  /** Previous tape entry for the per-second volatility measurement. */
  private lastRate: number | null = null;
  private lastRateTimestamp: number | null = null;

  private constructor(
    config: AdaptiveDeltaControllerConfig,
    key: string,
    store: SwapControllerStateStore,
    state: SwapControllerState
  ) {
    this.key = key;
    this.store = store;
    this.pair = config.pair;
    const epsilonFraction =
      config.epsilonHalfSpreadFraction ?? DEFAULT_EPSILON_HALF_SPREAD_FRACTION;
    this.epsilon = epsilonFraction * (config.advertisedSpread / 2);
    this.maxPacketAmount = config.maxPacketAmount;
    this.minPacketAmount = config.minPacketAmount ?? 1n;
    this.maxWindow = config.maxWindow ?? DEFAULT_MAX_WINDOW;
    this.cleanStreakLength =
      config.cleanStreakLength ?? DEFAULT_CLEAN_STREAK_LENGTH;
    this.coldStartDivisor = BigInt(
      config.coldStartDivisor ?? DEFAULT_COLD_START_DIVISOR
    );
    this.alpha = config.ewmaAlpha ?? DEFAULT_EWMA_ALPHA;
    this.now = config.now ?? Date.now;
    this.stateInternal = state;
    this.delta = BigInt(state.delta);
  }

  /**
   * Create a controller for one swap session: loads the persisted state for
   * the tuple from the store, or starts cold (`δ` unset until the first
   * `nextDelta()`, `W = 1`).
   */
  static async create(
    config: AdaptiveDeltaControllerConfig
  ): Promise<AdaptiveDeltaController> {
    validateConfig(config);
    const key = swapControllerStateKey({
      makerPubkey: config.makerPubkey,
      pair: config.pair,
    });
    const store = config.store ?? new InMemorySwapControllerStateStore();
    const now = config.now ?? Date.now;
    const loaded = await store.load(key);
    const state: SwapControllerState = isSwapControllerState(loaded)
      ? loaded
      : {
          v: 1,
          delta: '0',
          W: 1,
          vEwma: 0,
          tauEwma: 0,
          cleanStreak: 0,
          everShrunk: false,
          // 'window' so the FIRST widen step hits δ (alternation starts on δ).
          lastWidened: 'window',
          updatedAt: now(),
        };
    return new AdaptiveDeltaController(config, key, store, state);
  }

  /** Defensive snapshot of the current controller state. */
  get state(): SwapControllerState {
    return { ...this.stateInternal, delta: this.delta.toString() };
  }

  /** Current in-flight window W. */
  get window(): number {
    return this.stateInternal.W;
  }

  /**
   * Current `delta_cap = ε/(v·τ)` as a fraction of remaining notional.
   * `Infinity` while `v·τ` has no measurement yet (cold tape) — the
   * cold-start `δ_0` and absolute caps bound δ in that regime.
   */
  get deltaCapFraction(): number {
    const vTau = this.stateInternal.vEwma * this.stateInternal.tauEwma;
    if (!(vTau > 0)) return Infinity;
    return this.epsilon / vTau;
  }

  /** `delta_cap` in absolute source micro-units for a given remaining notional. */
  private deltaCapAbsolute(remaining: bigint): bigint {
    const frac = this.deltaCapFraction;
    if (!Number.isFinite(frac) || frac >= 1) return remaining;
    if (frac <= 0) return this.minPacketAmount;
    const scaled = BigInt(Math.floor(frac * CAP_SCALE_NUM));
    return (remaining * scaled) / CAP_SCALE;
  }

  /**
   * Decide the next packet size (source micro-units) for a session with
   * `remaining` notional left. Enforces, in order: the measured
   * `delta_cap = ε/(v·τ)` bound, the absolute `maxPacketAmount` cap, the
   * remaining notional, and the `minPacketAmount` floor. Seeds the
   * cold-start `δ_0 = min(delta_cap, notional/256, maxPacketAmount)` on
   * first call.
   */
  nextDelta(remaining: bigint): bigint {
    if (typeof remaining !== 'bigint' || remaining <= 0n) return 0n;

    if (this.delta0 === null) {
      // δ_0 is derived from the FIRST observed remaining (the session
      // notional) and reused as the additive widen increment all session.
      let d0 = remaining / this.coldStartDivisor;
      const capAbs = this.deltaCapAbsolute(remaining);
      if (d0 > capAbs) d0 = capAbs;
      if (this.maxPacketAmount !== undefined && d0 > this.maxPacketAmount) {
        d0 = this.maxPacketAmount;
      }
      if (d0 < this.minPacketAmount) d0 = this.minPacketAmount;
      this.delta0 = d0;
      if (this.delta <= 0n) {
        // Cold start: seed the ramp value. Persisted on the next observe().
        this.delta = d0;
        this.stateInternal.delta = d0.toString();
      }
    }

    let d = this.delta;
    const capAbs = this.deltaCapAbsolute(remaining);
    if (d > capAbs) d = capAbs;
    if (this.maxPacketAmount !== undefined && d > this.maxPacketAmount) {
      d = this.maxPacketAmount;
    }
    if (d > remaining) d = remaining;
    const floor =
      this.minPacketAmount < remaining ? this.minPacketAmount : remaining;
    if (d < floor) d = floor;
    return d;
  }

  /**
   * Feed one packet observation: updates the measured EWMAs (`v`, `τ`),
   * applies at most ONE knob adjustment (asymmetric: multiplicative shrink /
   * additive widen), and persists the state.
   */
  async observe(observation: PacketObservation): Promise<void> {
    const s = this.stateInternal;

    // --- Measurements (not knobs): τ and v EWMAs update on every packet ---
    if (
      typeof observation.rttMs === 'number' &&
      Number.isFinite(observation.rttMs) &&
      observation.rttMs > 0
    ) {
      const tauSec = observation.rttMs / 1000;
      s.tauEwma =
        s.tauEwma === 0
          ? tauSec
          : this.alpha * tauSec + (1 - this.alpha) * s.tauEwma;
    }
    if (
      typeof observation.rate === 'string' &&
      typeof observation.rateTimestamp === 'number' &&
      Number.isFinite(observation.rateTimestamp)
    ) {
      const r = rateToNumber(observation.rate);
      if (!Number.isNaN(r)) {
        if (
          this.lastRate !== null &&
          this.lastRateTimestamp !== null &&
          observation.rateTimestamp > this.lastRateTimestamp
        ) {
          const dtSec =
            (observation.rateTimestamp - this.lastRateTimestamp) / 1000;
          const inst = Math.abs(r - this.lastRate) / this.lastRate / dtSec;
          if (Number.isFinite(inst)) {
            s.vEwma =
              s.vEwma === 0
                ? inst
                : this.alpha * inst + (1 - this.alpha) * s.vEwma;
          }
        }
        if (
          this.lastRateTimestamp === null ||
          observation.rateTimestamp >= this.lastRateTimestamp
        ) {
          this.lastRate = r;
          this.lastRateTimestamp = observation.rateTimestamp;
        }
      }
    }

    // --- Classify: shrink signal? (spec §6) ---
    const slip = this.realizedSlip(observation);
    const isShrink =
      observation.resolution !== 'fulfill' || slip > this.epsilon;

    // --- One knob per step ---
    if (isShrink) {
      if (observation.resolution === 'timeout') {
        // Timing/liveness signal → the window knob: W ← max(1, ⌈W/2⌉).
        s.W = Math.max(1, Math.ceil(s.W / 2));
      } else {
        // Pricing signal → the size knob: δ ← max(δ_min, δ/2).
        let d = this.delta / 2n;
        if (d < this.minPacketAmount) d = this.minPacketAmount;
        this.delta = d;
        s.delta = d.toString();
      }
      s.cleanStreak = 0;
      s.everShrunk = true;
    } else {
      s.cleanStreak += 1;
      if (s.cleanStreak >= this.cleanStreakLength) {
        s.cleanStreak = 0;
        const knob: 'delta' | 'window' =
          s.lastWidened === 'delta' ? 'window' : 'delta';
        if (knob === 'window') {
          s.W = Math.min(this.maxWindow, s.W + 1);
        } else {
          // Slow-start (never shrunk for this tuple): multiplicative ×2.
          // After the first loss event ever: additive +δ_0, permanently.
          const increment = this.delta0 ?? this.minPacketAmount;
          let d = s.everShrunk ? this.delta + increment : this.delta * 2n;
          if (this.maxPacketAmount !== undefined && d > this.maxPacketAmount) {
            d = this.maxPacketAmount;
          }
          if (
            observation.remaining !== undefined &&
            observation.remaining > 0n
          ) {
            const capAbs = this.deltaCapAbsolute(observation.remaining);
            if (d > capAbs) d = capAbs;
          }
          if (d < this.minPacketAmount) d = this.minPacketAmount;
          // Widen must never shrink (cap clamps can undershoot current δ).
          if (d < this.delta) d = this.delta;
          this.delta = d;
          s.delta = d.toString();
        }
        s.lastWidened = knob;
      }
    }

    s.updatedAt = this.now();
    await this.store.save(this.key, { ...s });
  }

  /**
   * Realized per-packet slip as a fraction: shortfall of the delivered
   * target amount vs the amount implied by the packet's own tape rate `R_i`
   * (spec §7.1 `Δcumulative` vs `⌊δ · R_i⌋` cross-check). `0` when the
   * inputs are unavailable or delivery met the tape.
   */
  private realizedSlip(observation: PacketObservation): number {
    if (
      observation.resolution !== 'fulfill' ||
      observation.rate === undefined ||
      observation.sourceAmount === undefined ||
      observation.targetAmount === undefined ||
      observation.sourceAmount <= 0n
    ) {
      return 0;
    }
    let expected: bigint;
    try {
      expected = applyRate({
        sourceAmount: observation.sourceAmount,
        fromScale: this.pair.from.assetScale,
        toScale: this.pair.to.assetScale,
        rate: observation.rate,
      });
    } catch {
      return 0;
    }
    if (expected <= 0n || observation.targetAmount >= expected) return 0;
    const shortfall = expected - observation.targetAmount;
    return Number((shortfall * 1_000_000n) / expected) / 1_000_000;
  }
}

function validateConfig(config: AdaptiveDeltaControllerConfig): void {
  if (
    typeof config.makerPubkey !== 'string' ||
    config.makerPubkey.length === 0
  ) {
    throw new SwapControllerError('makerPubkey must be a non-empty string');
  }
  if (
    !config.pair ||
    typeof config.pair !== 'object' ||
    !config.pair.from ||
    !config.pair.to ||
    typeof config.pair.from.chain !== 'string' ||
    typeof config.pair.to.chain !== 'string'
  ) {
    throw new SwapControllerError(
      'pair must be a SwapPair with from/to chain descriptors'
    );
  }
  if (
    typeof config.advertisedSpread !== 'number' ||
    !Number.isFinite(config.advertisedSpread) ||
    config.advertisedSpread <= 0
  ) {
    throw new SwapControllerError(
      `advertisedSpread must be a positive finite fraction, got ${String(
        config.advertisedSpread
      )}`
    );
  }
  if (
    config.epsilonHalfSpreadFraction !== undefined &&
    (typeof config.epsilonHalfSpreadFraction !== 'number' ||
      !Number.isFinite(config.epsilonHalfSpreadFraction) ||
      config.epsilonHalfSpreadFraction <= 0)
  ) {
    throw new SwapControllerError(
      'epsilonHalfSpreadFraction must be a positive finite number'
    );
  }
  if (
    config.maxPacketAmount !== undefined &&
    (typeof config.maxPacketAmount !== 'bigint' || config.maxPacketAmount <= 0n)
  ) {
    throw new SwapControllerError('maxPacketAmount must be a positive bigint');
  }
  if (
    config.minPacketAmount !== undefined &&
    (typeof config.minPacketAmount !== 'bigint' || config.minPacketAmount <= 0n)
  ) {
    throw new SwapControllerError('minPacketAmount must be a positive bigint');
  }
  if (
    config.minPacketAmount !== undefined &&
    config.maxPacketAmount !== undefined &&
    config.minPacketAmount > config.maxPacketAmount
  ) {
    throw new SwapControllerError('minPacketAmount must be <= maxPacketAmount');
  }
  if (
    config.maxWindow !== undefined &&
    (!Number.isInteger(config.maxWindow) || config.maxWindow < 1)
  ) {
    throw new SwapControllerError('maxWindow must be an integer >= 1');
  }
  if (
    config.cleanStreakLength !== undefined &&
    (!Number.isInteger(config.cleanStreakLength) ||
      config.cleanStreakLength < 1)
  ) {
    throw new SwapControllerError('cleanStreakLength must be an integer >= 1');
  }
  if (
    config.coldStartDivisor !== undefined &&
    (!Number.isInteger(config.coldStartDivisor) || config.coldStartDivisor < 1)
  ) {
    throw new SwapControllerError('coldStartDivisor must be an integer >= 1');
  }
  if (
    config.ewmaAlpha !== undefined &&
    (typeof config.ewmaAlpha !== 'number' ||
      !(config.ewmaAlpha > 0) ||
      config.ewmaAlpha > 1)
  ) {
    throw new SwapControllerError('ewmaAlpha must be in (0, 1]');
  }
}

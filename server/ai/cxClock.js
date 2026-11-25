// ============================================================
// server/ai/cxClock.js — v21.44.0 CoinDCX SERVER-TIME OFFSET
// ------------------------------------------------------------
// THE BUG (user report): is PC ka clock UTC se ~3-5s PEEChhe hai.
// CoinDCX ke tick timestamps (`T` / `ts`) UTC epoch hote hain, isliye
// `Date.now() - tick.time` NEGATIVE aata tha → har tick "0ms old" dikhta
// tha, stale tick bhi fresh lagta tha, aur ulta `now - time < 8s` gates
// (mark-price keep-alive, Binance accelerator suppression) fresh tick ko
// bhi stale maan ke unnecessary REST par gir jaate the.
//
// THE FIX: CoinDCX ke apne payload se server clock sample karo
// (`currentPrices@futures` / `@spot` ka `ts`, aur REST futures `j.ts`).
// Har sample ka skew (serverMs - localMs) median-filter hota hai, to
// ek-off event/slow frame offset ko nahi hilaata.
//
// DOCTRINE:
//   * Ye module SIRF clock offset deta hai — koi price nahi banata.
//   * |skew| > 5 min = parse/units error → sample reject (never a
//     silent 1-hour-shifted "fresh" label).
//   * Offset sirf freshness/latency labels ke liye. Fill prices
//     hamesha exchange ke apne LTP se aate hain (is module se nahi).
//   * Passive sampling default hai (zero extra network). Active probe
//     sirf tab jab 60s+ se koi sample nahi mila.
//   * NODE_ENV=test me active timer/probe OFF (hermetic suites).
// ============================================================

const MAX_OFFSET_MS = 5 * 60_000;     // sanity clamp for a bad parse
const SAMPLE_WINDOW = 7;              // median window
const PROBE_MIN_GAP_MS = 60_000;      // one active probe per minute max
const DEFAULT_PROBE_MS = 5 * 60_000;  // background refresh cadence
const FUT_RT_URL = 'https://public.coindcx.com/market_data/v3/current_prices/futures/rt';

// ---- state ----
let _offsetMs = 0;
let _samples = 0;
let _lastSampleAt = 0;
let _lastSampleSource = null;
let _lastLocalAt = 0;
let _recent = []; // [{ skew, at }]
let _probeAt = 0;
let _probeInflight = null;
let _probeTimer = null;
let _enabled = process.env.AI_CX_CLOCK !== '0';
let _nowFn = () => Date.now();

// ---- test hooks ----
export function _setCxClockNowForTest(fn) { _nowFn = typeof fn === 'function' ? fn : (() => Date.now()); }
export function _setCxClockEnabledForTest(v) { _enabled = !!v; }
export function _resetCxClockForTest() {
  _offsetMs = 0; _samples = 0; _lastSampleAt = 0; _lastSampleSource = null;
  _lastLocalAt = 0; _recent = []; _probeAt = 0; _probeInflight = null;
  if (_probeTimer) { clearInterval(_probeTimer); _probeTimer = null; }
  _nowFn = () => Date.now();
  _enabled = false;
}

const _num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
};

/** CoinDCX epoch → ms. The wire is inconsistent (futures `ts` is ms on
 *  the book channel, REST `j.ts` is seconds) — normalize once here. */
export function normalizeCxEpochMs(v) {
  const n = _num(v);
  if (!(n > 0)) return 0;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

/**
 * Record one CoinDCX server-clock observation. Safe to call on every
 * socket event (allocation-light, median over the last 7 samples).
 *
 * @param {number} serverMs  CoinDCX payload timestamp (s or ms)
 * @param {string} [source]  'fut-ws' | 'spot-ws' | 'rest-ts' | 'http-date'
 * @param {number} [localMs] local receive time (tests inject)
 * @returns {boolean} true when the sample was accepted
 */
export function noteCxServerTime(serverMs, source = 'cx-ws', localMs = _nowFn()) {
  const s = normalizeCxEpochMs(serverMs);
  if (!(s > 0)) return false;
  const skew = s - localMs;
  if (Math.abs(skew) > MAX_OFFSET_MS) return false; // bad units / stale replay
  _recent.push({ skew, at: localMs });
  if (_recent.length > SAMPLE_WINDOW) _recent.shift();
  const sorted = _recent.map(x => x.skew).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  // A single wild sample must not move a warm offset by >2s.
  if (_samples >= 3 && Math.abs(median - _offsetMs) > 2_000) {
    _recent = _recent.slice(-3);
    return false;
  }
  _offsetMs = Math.round(median);
  _samples += 1;
  _lastSampleAt = localMs;
  _lastLocalAt = localMs;
  _lastSampleSource = String(source || 'cx-ws');
  return true;
}

/** CoinDCX-corrected "now" in epoch ms. Use this when comparing an
 *  EXCHANGE timestamp against the current time (never for local
 *  ingest ages — those use liveFeed.receivedAt). */
export function cxNow() {
  return _nowFn() + _offsetMs;
}

/** Current offset (CoinDCX now - local now, ms). */
export function cxClockOffsetMs() { return _offsetMs; }

/** Diagnostics for /api/stream status + /api/feed-status. */
export function cxClockStatus() {
  const now = _nowFn();
  return {
    offsetMs: _offsetMs,
    samples: _samples,
    lastSampleAt: _lastSampleAt,
    source: _lastSampleSource,
    sampleAgeMs: _lastSampleAt > 0 ? Math.max(0, now - _lastSampleAt) : null,
    enabled: _enabled,
  };
}

/**
 * Active fallback probe — only when passive samples are stale. Reads
 * CoinDCX's RT payload `ts` first; falls back to the HTTP `Date` header
 * (1s precision) so a WAF-shaped payload still calibrates.
 */
export async function refreshCxClock({ url = FUT_RT_URL, timeoutMs = 6_000 } = {}) {
  if (!_enabled) return cxClockStatus();
  const now = _nowFn();
  if (now - _probeAt < PROBE_MIN_GAP_MS) return cxClockStatus();
  if (_probeInflight) return _probeInflight;
  _probeAt = now;
  _probeInflight = (async () => {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'SmartAI-Pro/21.44' }, signal: AbortSignal.timeout(timeoutMs) });
      try {
        const j = await r.json();
        const ts = normalizeCxEpochMs(j?.ts);
        if (ts > 0 && noteCxServerTime(ts, 'rest-ts')) return cxClockStatus();
      } catch { /* payload shape — try the Date header below */ }
      const dateHdr = r.headers?.get?.('date');
      const parsed = dateHdr ? Date.parse(dateHdr) : NaN;
      if (Number.isFinite(parsed) && parsed > 0) noteCxServerTime(parsed, 'http-date');
    } catch {
      // Last resort: api.coindcx.com's Date header (independent host).
      try {
        const r2 = await fetch('https://api.coindcx.com/exchange/ticker', { method: 'GET', headers: { 'User-Agent': 'SmartAI-Pro/21.44' }, signal: AbortSignal.timeout(timeoutMs) });
        const parsed = Date.parse(r2.headers?.get?.('date') || '');
        if (Number.isFinite(parsed) && parsed > 0) noteCxServerTime(parsed, 'http-date');
      } catch { /* clock stays at its last good offset */ }
    }
    return cxClockStatus();
  })();
  try { return await _probeInflight; } finally { _probeInflight = null; }
}

/**
 * Background refresh (unref'd). Passive WS/REST samples usually keep
 * this unnecessary; it only guarantees a warm offset after boot and
 * when a spot-only session has no futures traffic.
 */
export function startCxClock({ intervalMs = DEFAULT_PROBE_MS } = {}) {
  if (!_enabled || _probeTimer) return;
  if (process.env.NODE_ENV === 'test') return;
  if (!(_samples > 0)) void refreshCxClock();
  _probeTimer = setInterval(() => { void refreshCxClock(); }, Math.max(PROBE_MIN_GAP_MS, intervalMs));
  if (typeof _probeTimer.unref === 'function') _probeTimer.unref();
}

/** Stop the background probe (graceful shutdown/tests). */
export function stopCxClock() {
  if (_probeTimer) { clearInterval(_probeTimer); _probeTimer = null; }
}

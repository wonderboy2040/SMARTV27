// ============================================================
// liveFeed — central in-memory tick store + pub/sub for SSE
// ------------------------------------------------------------
// Every real-time source (NSE, Finnhub US, Binance crypto) writes the latest
// tick here, keyed exactly like the frontend price map:
//   IN_<symbol>  US_<symbol>   (crypto is stored as IN_<symbol> too)
// The /api/stream SSE endpoint reads/pushes from here.
// ============================================================
const _ticks = new Map();        // key -> { price, change, high, low, volume, time, source }
const _subscribers = new Set();  // fn(key, data)
const _sourceSeen = {};          // source -> last tick epoch (for feed-status)

export function setTick(key, data, source) {
  if (!key || !(data?.price > 0)) return;
  const now = Date.now();
  const tick = {
    price: data.price,
    change: typeof data.change === 'number' ? data.change : 0,
    high: data.high ?? data.price,
    low: data.low ?? data.price,
    volume: data.volume ?? 0,
    time: data.time ?? now,
    // v21.41.0 [ENTRY QUOTE FRESHNESS]: exchange time can be seconds old (or
    // clock-skewed). This is the local INGEST timestamp the entry gate trusts
    // when it asks "is this quote still tradeable?".
    receivedAt: now,
    // v21.44.0 [CLOCK-SKEW HONESTY]: the exchange's OWN clock, when the
    // source provides one. `time` can be a local stamp (spot direct push)
    // or a trade stamp (futures WS), so downstream freshness MUST NOT
    // guess. `exchangeTime` is normalized to ms and used only to compute
    // the true quote age against cxNow() — never as an ingest clock.
    exchangeTime: (() => {
      const raw = Number(data.exchangeTime ?? data.exchangeTs);
      if (!(raw > 0)) return undefined;
      return raw < 1e12 ? Math.round(raw * 1000) : Math.round(raw);
    })(),
    // v21.44.0 [LTP-ONLY FILLS]: a mark-price keep-alive is a valid display
    // tick but NEVER a tradeable LTP. Tag it so entry/fill gates can skip it.
    basis: data.basis === 'mark' ? 'mark' : undefined,
    source: source || data.source || 'live',
    // 2026 P&L accuracy pass: the REAL previous close (when the source
    // provides it) so Today's P&L = (price - prevClose) * qty exactly —
    // no more back-computing from the rounded change % (which drifts).
    prevClose: (typeof data.prevClose === 'number' && data.prevClose > 0) ? data.prevClose : undefined,
  };
  _ticks.set(key, tick);
  if (source) _sourceSeen[source] = Date.now();
  for (const fn of _subscribers) {
    try { fn(key, tick); } catch { /* ignore subscriber errors */ }
  }
}

export function getTick(key) {
  return _ticks.get(key) || null;
}

/**
 * v21.44.0 [CLOCK-SKEW IMMUNITY] — age of OUR ingest, not of the exchange
 * epoch. `receivedAt` is written with the server's local clock, so
 * `localNow - receivedAt` is exact even when the box clock is 3-5s behind
 * UTC (the old `Date.now() - tick.time` produced NEGATIVE ages for
 * CoinDCX ticks and made stale quotes look fresh).
 *
 * Fallback to `time` only for hand-built ticks that predate receivedAt
 * (tests/fixtures); every live setTick() carries receivedAt.
 *
 * @param {{receivedAt?:number,time?:number}} tick
 * @param {number} [now] local epoch ms
 * @returns {number} age in ms (>=0), Infinity when no timestamp exists
 */
export function tickAgeMs(tick, now = Date.now()) {
  const at = Number(tick?.receivedAt);
  if (at > 0) return Math.max(0, now - at);
  const t = Number(tick?.time);
  return t > 0 ? Math.max(0, now - t) : Infinity;
}

/**
 * v21.41.0 [ENTRY QUOTE FRESHNESS] — liveFeed namespaces a board symbol can
 * legitimately appear under. `execMarket` is the ticket's execution desk
 * (INDIA / FUTURES / GLOBALFUTURES). The expected namespace is probed first;
 * the siblings are only used when their price is within `quoteFreshness`'s
 * tolerance (so an INR spot tick can never masquerade as a USDT perp quote).
 *
 * @param {string} symbol
 * @param {string} [execMarket]
 * @returns {string[]}
 */
export function entryFeedKeys(symbol, execMarket) {
  const sym = String(symbol || '').toUpperCase().replace(/^(FUT_|GLOB_|IN_|US_)/, '');
  if (!sym) return [];
  const exec = String(execMarket || '').toUpperCase();
  const primary = exec === 'INDIA'
    ? `IN_${sym}`
    : (exec === 'GLOBALFUTURES' ? `GLOB_${sym}` : `FUT_${sym}`);
  const keys = [primary];
  for (const k of [`FUT_${sym}`, `IN_${sym}`, `GLOB_${sym}`, `US_${sym}`]) {
    if (!keys.includes(k)) keys.push(k);
  }
  return keys;
}

/**
 * v21.41.0 [ENTRY QUOTE FRESHNESS] — one small helper shared by the manual
 * and auto entry lanes. It returns the age of the freshest liveFeed tick whose
 * price still matches the quote being evaluated, or null when no comparable
 * tick exists (missing evidence must fail OPEN, never fabricate a stale block).
 *
 * @param {string[]} keys            candidate liveFeed keys (FUT_BTC, IN_BTC…)
 * @param {number}   price           the quote the entry gate is about to use
 * @param {{now?:number, tolerancePct?:number}} [opts]
 * @returns {{ageMs:number, source:string|null, key:string, price:number, basis:string|null}|null}
 */
export function quoteFreshness(keys, price, { now = Date.now(), tolerancePct = 1 } = {}) {
  const px = Number(price);
  if (!(px > 0)) return null;
  const tol = Math.max(0, Math.min(10, Number(tolerancePct) || 1)) / 100;
  let best = null;
  for (const key of Array.isArray(keys) ? keys : [keys]) {
    const t = _ticks.get(key);
    const tickPx = Number(t?.price);
    const receivedAt = Number(t?.receivedAt);
    if (!(tickPx > 0) || !(receivedAt > 0)) continue;
    // v21.44.0: mark-price keep-alives are display-only. A paper/live fill
    // must never source its LTP from the mark while a true last price ages.
    if (t?.basis === 'mark') continue;
    if (Math.abs(tickPx - px) / px > tol) continue;
    if (!best || receivedAt > best.receivedAt) {
      best = { receivedAt, source: t.source || null, key, price: tickPx, basis: t.basis || null };
    }
  }
  if (!best) return null;
  return {
    ageMs: Math.max(0, now - best.receivedAt),
    source: best.source,
    key: best.key,
    price: best.price,
    basis: best.basis,
  };
}

export function snapshot(keys) {
  const out = {};
  (keys || []).forEach(k => { const t = _ticks.get(k); if (t) out[k] = t; });
  return out;
}

export function subscribe(fn) {
  _subscribers.add(fn);
  return () => _subscribers.delete(fn);
}

// Which sources have produced a tick in the last 60s (for the UI health dot).
export function feedStatus() {
  const now = Date.now();
  const live = {};
  for (const [src, at] of Object.entries(_sourceSeen)) {
    live[src] = (now - at) < 60000;
  }
  return live;
}

// v21.1.0 (Phase-3): per-source LAST-TICK AGES — /api/health + frontend strip
// ke liye. feedStatus() sirf booleans deta tha (60s window); ab har source ka
// age seconds me bhi milta hai (never-ticked sources skip — wo "not armed"
// hain, "stale" nahi).
export function feedAges() {
  const now = Date.now();
  const out = {};
  for (const [src, at] of Object.entries(_sourceSeen)) {
    out[src] = { lastTickAt: at, ageSec: Math.max(0, Math.round((now - at) / 1000)) };
  }
  return out;
}

// Housekeeping (2026 perf audit M2): _ticks previously grew forever — every
// key ever ticked stayed in the map for the whole process lifetime. Snapshots
// only ever ask for keys an active client cares about, so anything stale
// (>30 min without an update, map larger than 300) is safely evictable.
setInterval(() => {
  if (_ticks.size <= 300) return;
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [k, t] of _ticks) {
    if ((t.time || 0) < cutoff) _ticks.delete(k);
  }
}, 5 * 60 * 1000).unref?.();

// v19.1 selfHeal hook: AGGRESSIVE prune under memory pressure. Evicts
// everything older than 5 min; if the map is still >200 entries, evicts
// oldest-first down to 200. Called ONLY by the never-down guard's trim
// registry (registerTrim('liveFeed', pruneLiveFeedNow)) — the normal
// housekeeping above is untouched. Next tick for a still-watched symbol
// re-populates it instantly, so the cost is one extra upstream fetch
// per live symbol — the right trade under memory pressure.
export function pruneLiveFeedNow() {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [k, t] of _ticks) {
    if ((t.time || 0) < cutoff) _ticks.delete(k);
  }
  if (_ticks.size > 200) {
    const entries = [..._ticks.entries()].sort((a, b) => (a[1].time || 0) - (b[1].time || 0));
    for (let i = 0; i < entries.length - 200; i++) _ticks.delete(entries[i][0]);
  }
  return _ticks.size;
}

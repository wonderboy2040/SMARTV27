// ============================================================
// server/lib/tickGate.js — v21.44.0 PER-SYMBOL SSE TICK GATE
// ------------------------------------------------------------
// Extracted from /api/stream so the wire discipline is unit-testable.
//
// Two domains, two honest cadences:
//   FAST (CoinDCX spot INR / FUT / GLOB): 100ms cap, 0.001% dead-band,
//        15s flat-price heartbeat. Live probe: perps ~1.5 updates/sec,
//        INR spot ~1 per 7-10s — both far below the cap, so every real
//        exchange tick reaches the browser.
//   SLOW (NSE/US equities): 1000ms cap, 0.05% dead-band, 45s heartbeat
//        (the proven pre-v21.44 shape — unchanged).
//
// `at` is the last SENT time, NOT the last received time. The old gate
// refreshed it on dead-band suppression, so a real move could lose its
// slot to a stream of tiny ticks. Here a move above the band lands at the
// next allowed slot; identical ticks stay suppressed until heartbeat.
// ============================================================

export const TICK_GATE_DEFAULTS = Object.freeze({
  fastGapMs: 100,
  slowGapMs: 1_000,
  fastBand: 0.00001,   // 0.001%
  slowBand: 0.0005,    // 0.05%
  fastHeartbeatMs: 15_000,
  slowHeartbeatMs: 45_000,
});

/**
 * @param {{fastKeys?: Set<string>|((key:string)=>boolean)}} opts
 * @returns {(key:string, price:number, now?:number) => boolean}
 */
export function createTickGate({ fastKeys = new Set() } = {}) {
  const last = new Map(); // key -> { at, price }
  const isFast = typeof fastKeys === 'function'
    ? fastKeys
    : (key) => fastKeys.has(key);

  return function shouldSend(key, price, now = Date.now()) {
    if (!key) return false;
    const fast = isFast(key);
    const gapMs = fast ? TICK_GATE_DEFAULTS.fastGapMs : TICK_GATE_DEFAULTS.slowGapMs;
    const band = fast ? TICK_GATE_DEFAULTS.fastBand : TICK_GATE_DEFAULTS.slowBand;
    const heartbeatMs = fast ? TICK_GATE_DEFAULTS.fastHeartbeatMs : TICK_GATE_DEFAULTS.slowHeartbeatMs;
    const px = Number(price);
    const prev = last.get(key);

    if (prev) {
      const sinceSend = now - prev.at;
      if (sinceSend < gapMs) return false; // hard wire cap
      if (Number.isFinite(prev.price) && prev.price > 0
        && Number.isFinite(px) && px > 0
        && Math.abs(px - prev.price) / prev.price < band
        && sinceSend < heartbeatMs) {
        return false; // flat/noise — the heartbeat owns the next frame
      }
    }
    last.set(key, { at: now, price: Number.isFinite(px) && px > 0 ? px : null });
    return true;
  };
}

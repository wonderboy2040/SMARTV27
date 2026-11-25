// ============================================================
// test/tickGateV21440.test.ts — v21.44.0 SSE WIRE DISCIPLINE
// ------------------------------------------------------------
// The user target is "as fast as CoinDCX allows, honestly":
//   • FAST keys (CoinDCX): every genuine tick passes (100ms cap is far
//     above the measured ~1.5/sec perp / ~1-per-7-10s INR cadence).
//   • SLOW keys (equities): the proven 1s / 0.05% gate is unchanged.
//   • A move above the dead-band lands at the next allowed slot even if
//     tiny ticks were suppressed in between (old gate starved it).
//   • Identical prices are suppressed until the honesty heartbeat.
// ============================================================
import { describe, it, expect } from 'vitest';
import { createTickGate } from '../server/lib/tickGate.js';

const FAST = new Set(['FUT_BTC', 'IN_BTC', 'GLOB_AAPL']);
const gate = () => createTickGate({ fastKeys: FAST });

describe('v21.44.0 — domain-aware SSE tick gate', () => {
  it('fast: every genuine tick passes (no 1s starvation)', () => {
    const g = gate();
    const t0 = 1_000_000;
    expect(g('FUT_BTC', 100, t0)).toBe(true);
    expect(g('FUT_BTC', 100.2, t0 + 660)).toBe(true);
    expect(g('FUT_BTC', 100.4, t0 + 1_320)).toBe(true);
  });

  it('fast: 100ms hard cap bounds a pathological burst', () => {
    const g = gate();
    const t0 = 1_000_000;
    expect(g('FUT_BTC', 100, t0)).toBe(true);
    expect(g('FUT_BTC', 101, t0 + 50)).toBe(false);  // inside the cap
    expect(g('FUT_BTC', 101, t0 + 110)).toBe(true);  // next slot, real move
  });

  it('fast: identical price is suppressed until the 15s heartbeat', () => {
    const g = gate();
    const t0 = 1_000_000;
    expect(g('IN_BTC', 50, t0)).toBe(true);
    expect(g('IN_BTC', 50, t0 + 14_900)).toBe(false);
    expect(g('IN_BTC', 50, t0 + 15_100)).toBe(true);
  });

  it('fast: a real move above 0.001% is never treated as noise', () => {
    const g = gate();
    const t0 = 1_000_000;
    expect(g('FUT_BTC', 100_000, t0)).toBe(true);
    // +₹1 = 0.001% — at/above the band, must pass on the next slot.
    expect(g('FUT_BTC', 100_001, t0 + 150)).toBe(true);
  });

  it('slow (equities): keeps the 1s / 0.05% contract', () => {
    const g = gate();
    const t0 = 1_000_000;
    expect(g('IN_RELIANCE', 2_900, t0)).toBe(true);
    expect(g('IN_RELIANCE', 2_950, t0 + 500)).toBe(false);  // inside 1s
    expect(g('IN_RELIANCE', 2_950, t0 + 1_100)).toBe(true); // real move passes
    expect(g('IN_RELIANCE', 2_950, t0 + 1_200)).toBe(false); // <0.05% noise
  });

  it('unknown keys default to the safe equity cadence', () => {
    const g = gate();
    const t0 = 1_000_000;
    expect(g('IN_UNKNOWN', 10, t0)).toBe(true);
    expect(g('IN_UNKNOWN', 10.1, t0 + 200)).toBe(false);
  });
});

// v21.37.2 — CandleChart live forming-bar merge (display-only overlay).
// The chart used to repaint only on the 60s anchor fetch; these locks pin
// the relative-bar rule that makes the forming candle track the SSE tick.
import { describe, expect, it } from 'vitest';
import { mergeLiveTick } from '../src/components/aitrading/CandleChart';

const T0 = 1_700_000_000_000; // arbitrary 5m-grid bar open
const bar = (t, close, high = close, low = close) => ({ time: t, open: close, high, low, close, volume: 12 });
const series = () => [bar(T0 - 300_000, 100), bar(T0, 100, 101, 99)];

describe('mergeLiveTick — live forming bar', () => {
  it('patches the forming bar in place (close/high/low) without mutating the anchor', () => {
    const base = series();
    const out = mergeLiveTick(base, 102, '5m', T0 + 60_000);
    expect(out).not.toBe(base);
    expect(base[1].close).toBe(100);
    expect(out[1]).toMatchObject({ time: T0, close: 102, high: 102, low: 99 });
    expect(out).toHaveLength(2);
  });

  it('extends the low when the tick trades below the anchor low', () => {
    const out = mergeLiveTick(series(), 97.5, '5m', T0 + 90_000);
    expect(out[1]).toMatchObject({ close: 97.5, high: 101, low: 97.5 });
  });

  it('rolls exactly one live bar in the next window (volume 0, self-heals on fetch)', () => {
    const out = mergeLiveTick(series(), 103, '5m', T0 + 300_000 + 1_000);
    expect(out).toHaveLength(3);
    expect(out[2]).toEqual({ time: T0 + 300_000, open: 103, high: 103, low: 103, close: 103, volume: 0 });
    // a second call re-derives from the same anchor — never compounds
    const again = mergeLiveTick(series(), 104, '5m', T0 + 300_000 + 2_000);
    expect(again).toHaveLength(3);
    expect(again[2].open).toBe(104);
  });

  it('leaves a series ≥2 windows stale untouched (hidden-tab wake-up safety)', () => {
    const base = series();
    expect(mergeLiveTick(base, 103, '5m', T0 + 600_000)).toBe(base);
  });

  it('rejects a >5% cross-domain/scale print', () => {
    const base = series();
    expect(mergeLiveTick(base, 106.01, '5m', T0 + 60_000)).toBe(base);
  });

  it('is a zero-cost no-op without a finite positive ltp', () => {
    const base = series();
    expect(mergeLiveTick(base, null, '5m', T0 + 60_000)).toBe(base);
    expect(mergeLiveTick(base, 0, '5m', T0 + 60_000)).toBe(base);
    expect(mergeLiveTick(base, Number.NaN, '5m', T0 + 60_000)).toBe(base);
    expect(mergeLiveTick(null, 100, '5m', T0)).toBeNull();
  });
});

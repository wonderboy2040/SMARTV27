// ============================================================
// test/cxRealtimeV21440.test.ts — v21.44.0 REALTIME HONESTY CONTRACT
// ------------------------------------------------------------
// Locks the three fixes behind "prices as fast as CoinDCX allows,
// without fake freshness":
//   1. CoinDCX server-clock offset (this box runs 3-5s behind UTC)
//      → quote ages can never go negative / look fresh by accident.
//   2. liveFeed.tickAgeMs measures OUR ingest (receivedAt), not the
//      exchange epoch against a skewed local clock.
//   3. mark-price keep-alives are display-only — quoteFreshness must
//      never certify a mark as a tradeable LTP.
//   4. The client age helper adds elapsed time to the server's
//      feedAgeMs (freshness keeps decaying between frames).
// ============================================================
import { describe, it, expect, beforeEach } from 'vitest';
import {
  noteCxServerTime, cxNow, cxClockOffsetMs, cxClockStatus,
  _resetCxClockForTest, _setCxClockNowForTest,
} from '../server/ai/cxClock.js';
import { setTick, getTick, tickAgeMs, quoteFreshness } from '../server/liveFeed.js';
import { liveTickAgeMs } from '../src/components/aitrading/manualLiveMerge';

const LOCAL = 1_700_000_000_000;

describe('v21.44.0 — CoinDCX clock offset', () => {
  beforeEach(() => {
    _resetCxClockForTest();
    _setCxClockNowForTest(() => LOCAL);
  });

  it('uses the median of recent samples (one jittery frame cannot move it)', () => {
    _setCxClockNowForTest(() => LOCAL);
    noteCxServerTime(LOCAL + 3_500, 'fut-ws', LOCAL);
    noteCxServerTime(LOCAL + 3_450, 'fut-ws', LOCAL + 100);
    noteCxServerTime(LOCAL + 9_000, 'fut-ws', LOCAL + 200); // jitter/outlier
    expect(cxClockOffsetMs()).toBe(3_500);
    expect(cxNow()).toBe(LOCAL + 3_500);
    const st = cxClockStatus();
    expect(st.samples).toBeGreaterThan(0);
    expect(st.source).toBe('fut-ws');
  });

  it('normalizes seconds-based epochs and rejects absurd skew', () => {
    _setCxClockNowForTest(() => LOCAL);
    expect(noteCxServerTime((LOCAL + 3_500) / 1000, 'rest-ts', LOCAL)).toBe(true);
    expect(cxClockOffsetMs()).toBe(3_500);
    // 1 hour off = bad units/stale replay, never a "fresh" clock.
    expect(noteCxServerTime(LOCAL + 60 * 60_000, 'bad', LOCAL)).toBe(false);
    expect(cxClockOffsetMs()).toBe(3_500);
  });
});

describe('v21.44.0 — ingest age is skew-proof', () => {
  it('tickAgeMs uses receivedAt even when the exchange timestamp is ahead', () => {
    const key = 'FUT__SKEWTEST';
    const localNow = Date.now();
    // Exchange stamp 5s in the future (the actual clock-skew shape).
    setTick(key, { price: 100, time: localNow + 5_000, exchangeTime: localNow + 5_000 }, 'coindcx-fut-ws');
    const t = getTick(key)!;
    const age = tickAgeMs(t, Date.now());
    expect(age).toBeGreaterThanOrEqual(0);
    expect(age).toBeLessThan(2_000);
  });

  it('quoteFreshness refuses a mark-price keep-alive (display-only)', () => {
    const markKey = 'FUT__MARKONLYTEST';
    const ltpKey = 'FUT__LTPONLYTEST';
    setTick(markKey, { price: 55, basis: 'mark' }, 'coindcx-fut-mark');
    setTick(ltpKey, { price: 55 }, 'coindcx-fut-ws');
    expect(quoteFreshness([markKey], 55)).toBeNull();
    const ltp = quoteFreshness([ltpKey], 55);
    expect(ltp).not.toBeNull();
    expect(ltp!.basis).toBeNull();
  });
});

describe('v21.44.0 — client freshness keeps decaying', () => {
  it('adds elapsed-since-receipt to the server feed age', () => {
    const now = 10_000_000;
    const tick = { price: 1, time: now - 60_000, feedAgeMs: 1_000, recvAt: now - 500 };
    expect(liveTickAgeMs(tick, now)).toBe(1_500);
  });

  it('falls back to receivedAt when no server age is present', () => {
    const now = 10_000_000;
    expect(liveTickAgeMs({ price: 1, time: now - 9_000, receivedAt: now - 2_000 }, now)).toBe(2_000);
  });
});

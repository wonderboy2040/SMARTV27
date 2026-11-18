// ============================================================
// test/entryQuoteFreshnessV21410.test.ts — v21.41.0 QUOTE FRESHNESS
// ------------------------------------------------------------
// The board row could be fresh while the liveFeed tick it was priced
// against was minutes old (dead WS / silent REST leg). Locks:
//   • setTick stamps a local ingest timestamp (`receivedAt`);
//   • quoteFreshness returns the freshest PRICE-MATCHING tick's age (a
//     sibling INR spot tick can never stand in for a USDT perp quote);
//   • missing evidence fails OPEN (null), never fabricates a stale block;
//   • entryFeedKeys maps INDIA / GLOBALFUTURES / perps to liveFeed keys;
//   • the auto lane enforces the age through preEntryRecheck.
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mtf-quote-fresh-21410-'));
process.env.MTF_AUTO_DATA_DIR = TMP_DATA;

import { setTick, getTick, quoteFreshness, entryFeedKeys } from '../server/liveFeed.js';
import { __resetMtfAutoForTests } from '../server/ai/mtfAutoLink.js';
import { mtfAutoTick } from '../server/ai/mtfAutoLink.js';

vi.mock('../server/mcp/durable.js', () => ({ durablePut: vi.fn() }));

beforeEach(() => {
  __resetMtfAutoForTests();
  __resetMtfAutoForTests({
    config: { enabled: true, riskPerTradeINR: 2000, desks: { india: false, crypto: true } },
  });
});

describe('v21.41.0 — liveFeed ingest age', () => {
  it('setTick stamps receivedAt independently of exchange time', () => {
    const exchangeTime = Date.now() - 3_600_000; // an hour-old exchange stamp
    setTick('FUT_FRESHTEST', { price: 101, time: exchangeTime }, 'unit-ws');
    const tick = getTick('FUT_FRESHTEST');
    expect(tick?.time).toBe(exchangeTime);
    expect(tick?.receivedAt).toBeGreaterThan(exchangeTime);
    expect(Date.now() - tick.receivedAt).toBeLessThan(2_000);
  });

  it('quoteFreshness returns the freshest price-matching tick and skips mismatched namespaces', () => {
    setTick('IN_QTEST', { price: 8_400 }, 'inr-spot');       // ~84x the USDT quote
    setTick('FUT_QTEST', { price: 100 }, 'coindcx-fut-ws');
    const fresh = quoteFreshness(entryFeedKeys('QTEST', 'FUTURES'), 100);
    expect(fresh).not.toBeNull();
    expect(fresh?.key).toBe('FUT_QTEST');
    expect(fresh?.source).toBe('coindcx-fut-ws');
    expect(fresh?.ageMs).toBeLessThan(2_000);
  });

  it('returns null when no comparable tick exists (missing evidence fails open)', () => {
    expect(quoteFreshness(entryFeedKeys('MISSINGQ', 'FUTURES'), 100)).toBeNull();
    expect(quoteFreshness(['FUT_QTEST'], 250)).toBeNull(); // >1% price drift
    expect(quoteFreshness(['FUT_QTEST'], null as any)).toBeNull();
  });

  it('entryFeedKeys probes the execution namespace first and strips venue prefixes', () => {
    expect(entryFeedKeys('FUT_BTC', 'FUTURES')[0]).toBe('FUT_BTC');
    expect(entryFeedKeys('BTC', 'INDIA')[0]).toBe('IN_BTC');
    expect(entryFeedKeys('GLOB_NVDA', 'GLOBALFUTURES')[0]).toBe('GLOB_NVDA');
    expect(entryFeedKeys('BTC', 'FUTURES')).toEqual(
      expect.arrayContaining(['FUT_BTC', 'IN_BTC', 'GLOB_BTC', 'US_BTC']),
    );
    expect(entryFeedKeys('', 'FUTURES')).toEqual([]);
  });
});

// ------------------------------------------------------------
// auto lane enforcement
// ------------------------------------------------------------
function fakePaper() {
  const calls: any[] = [];
  const paper = {
    open: [],
    openPaperTrade: vi.fn((input: any) => {
      calls.push(input);
      const trade = { id: 700 + calls.length, ...input };
      paper.open.push({ id: trade.id, symbol: input.symbol, market: input.market, status: 'OPEN', direction: input.direction, openedAt: Date.now() } as never);
      return { ok: true, trade };
    }),
    closePaperTrade: vi.fn(() => ({ ok: true, trade: { id: 1, realizedPnl: 1 } })),
    getPaperSummary: vi.fn(() => ({ open: paper.open })),
  };
  return { paper, calls };
}

function boardFixture() {
  return {
    ok: true, market: 'CRYPTO', mode: 'INTRADAY', holdMin: 45, minScore: 75,
    rows: [{
      ok: true, symbol: 'BTCUSDT', market: 'CRYPTO', mode: 'INTRADAY', label: '15m → 5m', holdMin: 45,
      superScore: 82, tier: 'STRONG', side: 'LONG', dir: 1, grade: 'A',
      directionVerified: true, directionVerdict: 'VERIFIED',
      triggerFired: true, dualAligned: true, counterTrend: false, tfFit: 'OK',
      autoEligible: true, autoBlockers: [],
      plan: { entry: 100, stopLoss: 99, t1: 101, t2: 102 },
    }],
  };
}

const deps = (paper: any) => ({
  boards: { CRYPTO: boardFixture() },
  paper,
  usdtQuotes: new Map([['BTC', 100]]),
  now: Date.now(),
});

describe('v21.41.0 — auto lane rejects a stale quote', () => {
  it('blocks the entry when the matching liveFeed tick is older than 5s', async () => {
    setTick('FUT_BTC', { price: 100 }, 'coindcx-fut-ws');
    const tick = getTick('FUT_BTC');
    tick.receivedAt = Date.now() - 10_000; // simulate a dead WS for 10s
    const { paper, calls } = fakePaper();
    const out = await mtfAutoTick(deps(paper));
    expect(out.opened).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(out.skipped.join(' ')).toMatch(/pre-entry recheck blocked.*quote/i);
  });

  it('opens normally when the tick is fresh', async () => {
    setTick('FUT_BTC', { price: 100 }, 'coindcx-fut-ws');
    const { paper, calls } = fakePaper();
    const out = await mtfAutoTick(deps(paper));
    expect(out.opened).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });
});

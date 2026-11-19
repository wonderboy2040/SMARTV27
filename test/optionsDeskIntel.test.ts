// ============================================================
// test/optionsDeskIntel.test.ts — v21.42 SUPER-INTELLIGENCE
// OPTIONS DESK regression suite.
//
// Locks the upgrade contract:
//   1. pickExpiryForChain: never serve a T=0 expiry after close; roll
//      to the next expiry that actually HAS contracts (Groww payload
//      carries only the current expiry on expiry-day evenings).
//   2. chainConfluence: deterministic PCR/OI-lean/max-pain/GEX read,
//      aligned / opposed / model-chain honesty.
//   3. gradeBonus ladder: ELITE > STRONG > ACTION > WATCH (the old
//      code mapped ELITE to the WATCH fallback).
//   4. STRONG/ELITE cards require a FRESH LIVE chain — model, recent
//      and stale chains are capped below the strong bar.
//   5. strongSignal is a real gate (fresh live chain + strong score +
//      chain not opposed + tradeable grade).
// All hermetic — pure functions + synthetic chains, no network.
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  buildOptionSignalCards, buildSyntheticChain, pickExpiryForChain,
  LOT_SIZES, STRIKE_STEPS,
} from '../server/ai/optionsDesk.js';
import { directionRead, chainConfluence } from '../server/ai/optionsFlow.js';
import { nextWeeklyExpiry } from '../server/ai/lib/blackScholes.js';

const NIFTY_SPOT = 23400;
const nextWeekly = () => nextWeeklyExpiry(new Date(), 2);

function istDateOut(days: number) {
  const ist = new Date(Date.now() + days * 86400000 + 5.5 * 3600000);
  return ist.toISOString().slice(0, 10);
}

function mkDesk(overrides: Record<string, any> = {}) {
  const expiry = overrides.expiry || nextWeekly();
  return {
    ok: true, symbol: 'NIFTY', spot: NIFTY_SPOT, expiry, dte: 4,
    lotSize: LOT_SIZES.NIFTY, source: 'nse', venue: 'NSE',
    chainFetchedAt: Date.now(), chainAgeMs: 0, chainFresh: true,
    rows: buildSyntheticChain('NIFTY', NIFTY_SPOT, 0.13, expiry, 8)?.rows || [],
    ...overrides,
  };
}

function mkDeep(overrides: Record<string, any> = {}) {
  return {
    ok: true,
    signal: {
      symbol: 'NIFTY', side: 'LONG', confidence: 95, grade: 'STRONG', agreement: 0.9,
      plan: { entry: NIFTY_SPOT, stopLoss: NIFTY_SPOT - 90, target1: NIFTY_SPOT + 140, target2: NIFTY_SPOT + 260 },
      ...overrides,
    },
  };
}

/** Analytics that read BULLISH (PE writing + PCR + max-pain + gamma flip). */
const bullAnalytics = () => ({
  pcr: 1.5,
  maxPain: 23200,
  atmIV: 13,
  ivPercentile: 40,
  oiSkew: -2,
  callOI: 100000, putOI: 150000,
  flow: { oiLean: -0.3, callVolume: 1000, putVolume: 1600, callPutVolRatio: 0.6, oiLeanRead: 'PE writing', read: 'bullish' },
  gex: { gammaFlip: 23100, callWall: 23600, putWall: 23000, totalNetGex: 1e9, regimeNote: 'positive gamma' },
});

const atmOf = (cards: any[]) => cards.find(c => c.strikeBias === 'ATM') ?? cards[0];

describe('pickExpiryForChain — expiry-roll honesty', () => {
  const CHAIN = {
    expiryDates: ['2026-11-19', '2026-11-26', '2026-12-31'],
    rows: [
      ...Array.from({ length: 7 }, (_, i) => ({ strike: 23000 + i * 50, expiry: '2026-11-19' })),
      ...Array.from({ length: 7 }, (_, i) => ({ strike: 23000 + i * 50, expiry: '2026-11-26' })),
    ],
  };

  it('after 15:30 on expiry day, today is dropped and the next expiry WITH rows is picked', () => {
    const pick = pickExpiryForChain(CHAIN, { today: '2026-11-19', pastCloseToday: true });
    expect(pick.expiry).toBe('2026-11-26');
    expect(pick.rows.length).toBe(7);
    expect(pick.expiryRollPending).toBe(false);
  });

  it('expiry-day evening with NO next-expiry contracts in the payload → expiryRollPending, never T=0 rows', () => {
    const stale = { expiryDates: CHAIN.expiryDates, rows: CHAIN.rows.filter(r => r.expiry === '2026-11-19') };
    const pick = pickExpiryForChain(stale, { today: '2026-11-19', pastCloseToday: true });
    expect(pick.expiry).toBe('2026-11-26'); // declared next expiry
    expect(pick.rows).toHaveLength(0);      // no degenerate T=0 table
    expect(pick.expiryRollPending).toBe(true);
  });

  it('before close on expiry day, today is still selectable (and preferred when it has rows)', () => {
    const pick = pickExpiryForChain(CHAIN, { today: '2026-11-19', pastCloseToday: false });
    expect(pick.expiry).toBe('2026-11-19');
    expect(pick.rows.length).toBe(7);
  });
});

describe('chainConfluence — the deterministic chain read', () => {
  it('a BULLISH chain aligns with a CE (LONG) card and adds conviction', () => {
    const desk = { source: 'nse', spot: NIFTY_SPOT, analytics: bullAnalytics() };
    const c = chainConfluence(desk, 'LONG');
    expect(c.liveChain).toBe(true);
    expect(c.aligned).toBe(true);
    expect(c.opposed).toBe(false);
    expect(c.direction).toBe('BULLISH');
    expect(c.score).toBeGreaterThanOrEqual(5);
    expect(c.score).toBeLessThanOrEqual(10);
  });

  it('the same chain is OPPOSED to a PE (SHORT) card and subtracts the full 10', () => {
    const c = chainConfluence({ source: 'nse', spot: NIFTY_SPOT, analytics: bullAnalytics() }, 'SHORT');
    expect(c.opposed).toBe(true);
    expect(c.aligned).toBe(false);
    expect(c.score).toBe(-10);
  });

  it('a model chain has NO confluence (score 0 + explicit warning)', () => {
    const c = chainConfluence({ source: 'bs-model', spot: NIFTY_SPOT, analytics: bullAnalytics() }, 'LONG');
    expect(c.liveChain).toBe(false);
    expect(c.score).toBe(0);
    expect(c.warnings[0]).toContain('model-chain');
  });

  it('a live chain without analytics is neutral, not a fake confirmation', () => {
    const c = chainConfluence({ source: 'nse', spot: NIFTY_SPOT }, 'LONG');
    expect(c.liveChain).toBe(true);
    expect(c.score).toBe(0);
    expect(c.aligned).toBe(false);
    expect(c.opposed).toBe(false);
  });

  it('directionRead is the ONE tally both the desk and the scan use', () => {
    const d = directionRead({ spot: NIFTY_SPOT, analytics: bullAnalytics() });
    expect(d.pts).toBe(4);
    expect(d.direction).toBe('BULLISH');
    expect(d.why.length).toBe(4);
  });
});

describe('gradeBonus ladder — ELITE is the top rung (not the WATCH fallback)', () => {
  const scoreFor = (grade: string) => atmOf(buildOptionSignalCards(
    mkDesk(),
    mkDeep({ confidence: 74, grade }),
  )).aiScore;

  it('ELITE > STRONG > ACTION > WATCH on an otherwise identical live card', () => {
    const elite = scoreFor('ELITE');
    const strong = scoreFor('STRONG');
    const action = scoreFor('ACTION');
    const watch = scoreFor('WATCH');
    expect(elite).toBeGreaterThan(strong);
    expect(strong).toBeGreaterThan(action);
    expect(action).toBeGreaterThan(watch);
  });
});

describe('STRONG/ELITE gate — only a fresh LIVE chain can wear it', () => {
  it('fresh live chain + strong consensus + aligned flow → strongSignal true', () => {
    const cards = buildOptionSignalCards(
      mkDesk({ analytics: bullAnalytics(), chainAgeMs: 0 }),
      mkDeep(),
    );
    const c = atmOf(cards);
    expect(c.liveChain).toBe(true);
    expect(c.chainFresh).toBe(true);
    expect(['STRONG', 'ELITE']).toContain(c.tier);
    expect(c.strongSignal).toBe(true);
    expect(c.venue).toBe('NSE');
    expect(c.chainConfluence.aligned).toBe(true);
  });

  it('model chain is capped below STRONG even with a perfect consensus', () => {
    const cards = buildOptionSignalCards(
      mkDesk({ source: 'bs-model', venue: 'NSE', chainFetchedAt: undefined, chainAgeMs: null, analytics: null }),
      mkDeep({ confidence: 100, grade: 'ELITE' }),
    );
    const c = atmOf(cards);
    expect(c.liveChain).toBe(false);
    expect(c.aiScore).toBeLessThanOrEqual(74);
    expect(c.tier).not.toBe('STRONG');
    expect(c.tier).not.toBe('ELITE');
    expect(c.strongSignal).toBe(false);
    expect(c.freshness).toBe('model');
  });

  it('recent (45s–5m) live chain is capped below the 80 STRONG bar', () => {
    const cards = buildOptionSignalCards(
      mkDesk({ analytics: bullAnalytics(), chainAgeMs: 60_000, chainFetchedAt: Date.now() - 60_000 }),
      mkDeep({ confidence: 100, grade: 'ELITE' }),
    );
    const c = atmOf(cards);
    expect(c.freshness).toBe('recent');
    expect(c.aiScore).toBeLessThanOrEqual(79);
    expect(c.strongSignal).toBe(false);
  });

  it('stale (>5m) live chain is capped below STRONG and flagged', () => {
    const cards = buildOptionSignalCards(
      mkDesk({ analytics: bullAnalytics(), chainAgeMs: 10 * 60_000, chainFetchedAt: Date.now() - 10 * 60_000 }),
      mkDeep({ confidence: 100, grade: 'ELITE' }),
    );
    const c = atmOf(cards);
    expect(c.freshness).toBe('stale');
    expect(c.aiScore).toBeLessThanOrEqual(74);
    expect(c.strongSignal).toBe(false);
  });

  it('chain read AGAINST the card caps the score and blocks strongSignal', () => {
    const bearAnalytics = {
      ...bullAnalytics(),
      pcr: 0.5,
      maxPain: 23600,
      flow: { oiLean: 0.4, callVolume: 2000, putVolume: 800, callPutVolRatio: 2.5, oiLeanRead: 'CE writing', read: 'bearish' },
      gex: { gammaFlip: 23700, callWall: 23800, putWall: 23400, totalNetGex: -1e9, regimeNote: 'negative gamma' },
    };
    const cards = buildOptionSignalCards(
      mkDesk({ analytics: bearAnalytics, chainAgeMs: 0 }),
      mkDeep({ confidence: 100, grade: 'ELITE' }),
    );
    const c = atmOf(cards);
    expect(c.chainConfluence.opposed).toBe(true);
    expect(c.strongSignal).toBe(false);
  });
});

describe('venue + strike-step invariants stay intact', () => {
  it('NSE cards carry venue NSE and 50-step strikes; SENSEX keeps BSE + 100', () => {
    const n = atmOf(buildOptionSignalCards(mkDesk(), mkDeep()));
    expect(n.venue).toBe('NSE');
    expect(n.strike % STRIKE_STEPS.NIFTY).toBe(0);

    const sExpiry = nextWeeklyExpiry(new Date(), 4);
    const sDesk = mkDesk({
      symbol: 'SENSEX', spot: 82000, expiry: sExpiry, lotSize: LOT_SIZES.SENSEX,
      source: 'bse', venue: 'BSE', rows: buildSyntheticChain('SENSEX', 82000, 0.13, sExpiry, 8)?.rows || [],
    });
    const s = atmOf(buildOptionSignalCards(sDesk, mkDeep({ side: 'SHORT', plan: { entry: 82000, stopLoss: 82250, target1: 81700 } })));
    expect(s.venue).toBe('BSE');
    expect(s.strike % STRIKE_STEPS.SENSEX).toBe(0);
    expect(s.lotSize).toBe(LOT_SIZES.SENSEX);
  });
});

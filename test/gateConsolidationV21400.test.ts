// ============================================================
// test/gateConsolidationV21400.test.ts — v21.40.0
// ONE BLOCKER, ONE VOICE + configured-floor readiness + one ATR.
// ------------------------------------------------------------
// Evidence basis (18 Nov live board / paper ledger):
//   • Manual 409s repeated the same direction/score/main-grade reason 2–3×
//     because explicit clauses and row.autoBlockers were concatenated.
//   • Board `autoEligible` used the ACTION floor (65) while entry used 75,
//     so 65–74 rows looked "ready" and then failed at the click.
//   • Entry quality read only atrPct while preEntryRecheck resolved a real
//     absolute ATR — the same ticket could be judged on two volatility reads.
//
// These tests pin the consolidation. They never relax a veto: every clean
// fixture still passes only when every original gate is satisfied.
// ============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mtf-gate-consolidation-'));
process.env.MTF_AUTO_DATA_DIR = TMP_DATA;

vi.mock('../server/mcp/durable.js', () => ({
  durablePut: vi.fn(),
  decryptJSON: vi.fn(),
}));

import {
  dedupeEntryBlockers,
  computeEntryReadiness,
  mtfProEntryGate,
  dualAutoCandidates,
} from '../server/ai/mtfDualBoard.js';
import { measuredRowAtr, resolveRowAtr } from '../server/ai/preEntryGate.js';
import { evaluateLiveEntryQuality } from '../server/ai/mtfAutoLink.js';

const cleanRow = (over: Record<string, unknown> = {}) => ({
  ok: true,
  symbol: 'AVAX',
  market: 'CRYPTO',
  side: 'SHORT',
  superScore: 99,
  tier: 'ELITE',
  directionVerified: true,
  triggerFired: true,
  counterHtf: false,
  counterTrend: false,
  ensembleSignalAvailable: true,
  autoEligible: true,
  autoBlockers: [],
  plan: { entry: 30, stopLoss: 30.3, t1: 29.4, t2: 28.8 },
  ...over,
});

const mainShort = (over: Record<string, unknown> = {}) => ({
  side: 'SHORT',
  grade: 'STRONG',
  confidence: 84,
  mtf: { htfBias: 'BEARISH' },
  signalAge: { ageMs: 60 * 60_000 },
  verify: { veto: false, action: 'SELL' },
  ...over,
});

// ------------------------------------------------------------
// A) Dedupe — semantic copies collapse, distinct vetoes survive
// ------------------------------------------------------------
describe('dedupeEntryBlockers — repeats collapse, distinct vetoes survive', () => {
  it('keeps one copy of each semantic reason', () => {
    const out = dedupeEntryBlockers([
      'direction not PAKKA verified',
      'direction not pakka verified (WAIT-SHORT)',
      'trigger fire pending',
      'trigger fire pending',
      'score 58 < pro floor 75',
      'score 58 < 65',
      'main AI-BOARD grade WATCH actionable nahi (ACTION+ chahiye)',
      'main AI-BOARD grade WATCH conf 60 SHORT - ACTION+/confidence 60+ aligned signal chahiye',
      'liquidity sweep / trap veto active',
      'fresh supply/demand zone wall veto',
    ]);
    expect(out.filter(b => /^direction not pa/i.test(b))).toHaveLength(1);
    expect(out.filter(b => /^trigger fire pending/i.test(b))).toHaveLength(1);
    expect(out.filter(b => /^score \d+ </i.test(b))).toEqual(['score 58 < pro floor 75']);
    expect(out.filter(b => /^main AI-BOARD grade/i.test(b))).toHaveLength(1);
    // Distinct risk vetoes are never collapsed into one another.
    expect(out).toContain('liquidity sweep / trap veto active');
    expect(out).toContain('fresh supply/demand zone wall veto');
  });

  it('preserves order and is a no-op on clean input', () => {
    expect(dedupeEntryBlockers(['a', 'b'])).toEqual(['a', 'b']);
    expect(dedupeEntryBlockers([])).toEqual([]);
    expect(dedupeEntryBlockers(null as any)).toEqual([]);
  });
});

// ------------------------------------------------------------
// B) mtfProEntryGate — deduped output, identical pass/fail
// ------------------------------------------------------------
describe('mtfProEntryGate — deduped blockers without weakening the gate', () => {
  it('still allows a verified, triggered, ensemble-confirmed row', () => {
    const g = mtfProEntryGate(cleanRow(), { mainSignal: mainShort() });
    expect(g.ok).toBe(true);
    expect(g.blockers).toEqual([]);
  });

  it('blocks a WATCH row and reports each reason once', () => {
    const row = cleanRow({
      superScore: 58,
      tier: 'WATCH',
      directionVerified: false,
      triggerFired: false,
      ensembleSignalAvailable: false,
      autoEligible: false,
      autoBlockers: [
        'direction not pakka verified',
        'trigger fire pending',
        'score 58 < 65',
        'main AI-BOARD grade WATCH conf 60 SHORT - ACTION+/confidence 60+ aligned signal chahiye',
      ],
    });
    const g = mtfProEntryGate(row, { mainSignal: mainShort({ grade: 'WATCH', confidence: 60 }), minScore: 75 });
    expect(g.ok).toBe(false);
    expect(g.blockers.filter(b => /^direction not pa/i.test(b))).toHaveLength(1);
    expect(g.blockers.filter(b => /^trigger fire pending/i.test(b))).toHaveLength(1);
    expect(g.blockers.filter(b => /^score \d+ </i.test(b))).toEqual(['score 58 < pro floor 75']);
    expect(g.blockers.filter(b => /^main AI-BOARD grade/i.test(b))).toHaveLength(1);
  });

  it('keeps trap/HTF vetoes distinct from the deduped stack', () => {
    const g = mtfProEntryGate(cleanRow({
      trapVeto: true,
      counterHtf: true,
      htfBias: 'BULLISH',
    }), { mainSignal: mainShort() });
    expect(g.ok).toBe(false);
    expect(g.blockers).toContain('liquidity sweep / trap veto active');
    expect(g.blockers.some(b => /HTF bias BULLISH against SHORT/i.test(b))).toBe(true);
  });
});

// ------------------------------------------------------------
// C) dualAutoCandidates — same dedupe + availability de-noise
// ------------------------------------------------------------
describe('dualAutoCandidates — deduped pick blockers', () => {
  it('does not repeat the generic ensemble line when the row has the rich reason', () => {
    const row = cleanRow({
      superScore: 58,
      ensembleSignalAvailable: false,
      autoEligible: false,
      autoBlockers: ['main AI-BOARD grade WATCH conf 60 SHORT - ACTION+/confidence 60+ aligned signal chahiye'],
    });
    const [out] = dualAutoCandidates([row], { minScore: 75 });
    expect(out.autoPickBlockers.filter(b => /main AI-BOARD/i.test(b))).toHaveLength(1);
    expect(out.autoPickBlockers).toContain('score 58 < 75');
  });

  it('a clean candidate has no pick blockers', () => {
    const [out] = dualAutoCandidates([cleanRow()], { minScore: 75 });
    expect(out.autoPickBlockers).toEqual([]);
  });
});

// ------------------------------------------------------------
// D) entryReadiness — configured floor, not the ACTION floor
// ------------------------------------------------------------
describe('computeEntryReadiness — the floor the entry path actually uses', () => {
  it('65–74 ACTION rows are NOT entry-ready at the 75 floor', () => {
    const r = computeEntryReadiness({ autoEligible: true, superScore: 70, autoBlockers: [] }, 75);
    expect(r.eligible).toBe(false);
    expect(r.blockers).toEqual(['score 70 < entry floor 75']);
    expect(r.stage).toBe('quality');
  });

  it('a clean 80+ row is entry-ready', () => {
    const r = computeEntryReadiness({ autoEligible: true, superScore: 82, autoBlockers: [] }, 75);
    expect(r.eligible).toBe(true);
    expect(r.blockers).toEqual([]);
    expect(r.primary).toBeNull();
  });

  it('an ensemble blocker keeps the row not-ready even at 99', () => {
    const r = computeEntryReadiness({
      autoEligible: false,
      superScore: 99,
      autoBlockers: ['main AI-BOARD grade WATCH conf 60 SHORT - ACTION+/confidence 60+ aligned signal chahiye'],
    }, 75);
    expect(r.eligible).toBe(false);
    expect(r.stage).toBe('main-signal');
    expect(r.blockers).toHaveLength(1);
  });

  it('replaces the ACTION-floor score line without mutating the row', () => {
    const row = { autoEligible: false, superScore: 58, autoBlockers: ['score 58 < 65'] };
    const r = computeEntryReadiness(row, 75);
    expect(r.blockers).toEqual(['score 58 < entry floor 75']);
    expect(row.autoBlockers).toEqual(['score 58 < 65']);
  });
});

// ------------------------------------------------------------
// E) One ATR — entry quality uses the measured value, never a stop-derived one
// ------------------------------------------------------------
describe('one ATR across preEntryRecheck and entry quality', () => {
  it('measuredRowAtr reads explicit ATR, then real ATR%', () => {
    expect(measuredRowAtr({ atr: 2.5, atrPct: 9, entry: 100 })).toBe(2.5);
    expect(measuredRowAtr({ entry: 100, context: { atrPct: 0.5 } })).toBeCloseTo(0.5, 8);
  });

  it('measuredRowAtr never synthesises from stop distance or 1.2%', () => {
    expect(measuredRowAtr({ plan: { entry: 100, stopLoss: 98.6 } })).toBeNull();
    expect(measuredRowAtr({})).toBeNull();
    // resolveRowAtr keeps the legacy fallback for pre-entry timing only.
    expect(resolveRowAtr({ plan: { entry: 100, stopLoss: 98.6 }, atrSlMult: 1.4 })).toBeCloseTo(1, 8);
  });

  it('absolute measured ATR wins over a friendlier atrPct', () => {
    const row = { side: 'SHORT', trigger: { roc1: -0.05, roc3: -0.2, volRatio: 1.1 } };
    // stop 0.69% of entry; atrPct 0.5 would look safe, but the measured ATR
    // is 0.9% → 0.77× → noise stop-out (the exact AVAX class).
    const q = evaluateLiveEntryQuality(row, {
      entry: 100, stopLoss: 99.31, atrPct: 0.5, atr: 0.9,
    });
    expect(q.blocked).toBe(true);
    expect(q.reasons.join(' ')).toMatch(/noise stop-out/);
    expect(q.slAtrMult).toBeLessThan(1.1);
  });

  it('a genuinely wide stop still passes with the measured ATR', () => {
    const row = { side: 'SHORT', trigger: { roc1: -0.05, roc3: -0.2, volRatio: 1.1 } };
    const q = evaluateLiveEntryQuality(row, {
      entry: 100, stopLoss: 99.31, atrPct: 0.2, atr: 0.4,
    });
    expect(q.blocked).toBe(false);
    expect(q.slAtrMult).toBeGreaterThan(1.1);
  });
});

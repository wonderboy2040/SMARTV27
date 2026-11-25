// ============================================================
// test/preEntryGateV21380.test.ts — v21.38.0 PRE-ENTRY RECHECK
// ------------------------------------------------------------
// Evidence basis (server/data paper-trades.json + mtf-row-ledger.json):
//   • 30 of 49 closed MTF paper trades lost; 13 never worked (MFE < 0.1R).
//   • 8 losers had already shown >= 0.3R MFE and gave it back.
//   • median MFE 0.42R vs T1 at 1R — entries landed after the move.
//   • BNB paper opened seconds AFTER the live lane blocked the same setup.
//
// Locks:
//   1. resolveRowAtr priority (explicit → atrPct → risk÷mult → legacy 1.2%);
//   2. every pure pre-entry blocker (stale, chase, reversal, structure,
//      ≥0.75 ATR adverse, target-done, deep HOLD/STAND_ASIDE/conflict,
//      veto flags, unverified direction) + fail-open on missing evidence;
//   3. the auto tick ENFORCES the gate (and SHADOW records would-blocks);
//   4. paperLiveParity default ON — the paper lane runs the live gates;
//   5. mtfProEntryGate / dualAutoCandidates honour the MTF↔DEEP verdict;
//   6. the recheck loop resolves real ATR and emits STRUCTURE_BREAK/CAUTION.
// ============================================================
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mtf-preentry-21380-'));
process.env.MTF_AUTO_DATA_DIR = TMP_DATA;

import { preEntryRecheck, resolveRowAtr, PRE_ENTRY_DEFAULTS } from '../server/ai/preEntryGate.js';
import {
  mtfAutoTick, mtfAutoStatus, __resetMtfAutoForTests, loadMtfAutoConfig,
} from '../server/ai/mtfAutoLink.js';
import { __resetDirectionLocksForTests } from '../server/ai/directionLock.js';
import { mtfProEntryGate, dualAutoCandidates } from '../server/ai/mtfDualBoard.js';
import { recheckRow, priceStateTransition } from '../server/ai/signalRecheck.js';

vi.mock('../server/mcp/durable.js', () => ({ durablePut: vi.fn() }));

const NOW = 1_765_000_000_000;

// ------------------------------------------------------------
// Pure gate
// ------------------------------------------------------------
const row = (over: any = {}) => ({
  ok: true, symbol: 'BTCUSDT', side: 'LONG',
  directionVerified: true, directionVerdict: 'VERIFIED', triggerFired: true,
  plan: { entry: 100, stopLoss: 99, t1: 101, t2: 102 },
  context: { atrPct: 1 },
  builtAt: NOW,
  ...over,
});

describe('v21.38.0 — resolveRowAtr (real volatility, no blind 1.2%)', () => {
  it('prefers an explicit ATR, then atrPct, then risk÷ATR-mult, then legacy 1.2%', () => {
    expect(resolveRowAtr({ atr: 2.5, atrPct: 9, entry: 100 })).toBe(2.5);
    expect(resolveRowAtr({ entry: 100, atrPct: 1 })).toBeCloseTo(1, 8);
    expect(resolveRowAtr({ entry: 100, atrPct: 1, context: { atrPct: 0.5 } })).toBeCloseTo(1, 8);
    expect(resolveRowAtr({ entry: 100, context: { atrPct: 0.5 } })).toBeCloseTo(0.5, 8);
    expect(resolveRowAtr({ plan: { entry: 100, stopLoss: 98.6 } , atrSlMult: 1.4 })).toBeCloseTo(1, 8);
    expect(resolveRowAtr({ entry: 100 })).toBeCloseTo(1.2, 8);
    expect(resolveRowAtr({})).toBeNull();
  });

  it('exports conservative defaults', () => {
    expect(PRE_ENTRY_DEFAULTS.maxChaseRiskRatio).toBeLessThanOrEqual(0.25);
    expect(PRE_ENTRY_DEFAULTS.maxAdverseRiskRatio).toBeLessThanOrEqual(0.20);
    expect(PRE_ENTRY_DEFAULTS.blockAdverseAtrX).toBeLessThanOrEqual(0.75);
    expect(PRE_ENTRY_DEFAULTS.maxRowAgeMs).toBeLessThanOrEqual(120_000);
    expect(PRE_ENTRY_DEFAULTS.maxQuoteAgeMs).toBeLessThanOrEqual(5_000);
  });
});

describe('v21.38.0 — pure preEntryRecheck', () => {
  it('passes a clean fresh row at plan entry', () => {
    const out = preEntryRecheck({ row: row(), side: 'LONG', livePrice: 100, now: NOW });
    expect(out.ok).toBe(true);
    expect(out.state).toBe('OK');
    expect(out.blockers).toEqual([]);
    expect(out.metrics.atr).toBeCloseTo(1, 8);
  });

  it('blocks a stale row (builtAt older than the max age)', () => {
    const out = preEntryRecheck({
      row: row({ builtAt: NOW - 200_000 }), side: 'LONG', livePrice: 100, now: NOW,
    });
    expect(out.ok).toBe(false);
    expect(out.state).toBe('STALE');
    expect(out.blockers.join(' ')).toMatch(/stale/i);
  });

  it('v21.41.0: blocks a stale live quote by ingest age, fails open when the age is unknown', () => {
    const stale = preEntryRecheck({
      row: row(), side: 'LONG', livePrice: 100, now: NOW,
      quoteAgeMs: 6_000, quoteSource: 'coindcx-fut-ws',
    });
    expect(stale.ok).toBe(false);
    expect(stale.state).toBe('STALE');
    expect(stale.blockers.join(' ')).toMatch(/quote 6\.0s old/);
    expect(stale.metrics.quoteAgeMs).toBe(6_000);
    expect(stale.metrics.quoteSource).toBe('coindcx-fut-ws');

    const fresh = preEntryRecheck({ row: row(), side: 'LONG', livePrice: 100, now: NOW, quoteAgeMs: 3_000 });
    expect(fresh.ok).toBe(true);

    // Missing tick timestamp = missing evidence, never a fabricated block.
    const unknown = preEntryRecheck({ row: row(), side: 'LONG', livePrice: 100, now: NOW, quoteAgeMs: null });
    expect(unknown.ok).toBe(true);

    // Explicit threshold override (env/config surface).
    const relaxed = preEntryRecheck({
      row: row(), side: 'LONG', livePrice: 100, now: NOW, quoteAgeMs: 6_000,
      thresholds: { maxQuoteAgeMs: 10_000 },
    });
    expect(relaxed.ok).toBe(true);
  });

  it('blocks a late chase >25% of risk past entry, allows 20%', () => {
    const late = preEntryRecheck({ row: row(), side: 'LONG', livePrice: 100.3, now: NOW });
    expect(late.ok).toBe(false);
    expect(late.state).toBe('LATE_CHASE');
    expect(late.metrics.chaseRatio).toBeCloseTo(0.3, 3);
    const ok = preEntryRecheck({ row: row(), side: 'LONG', livePrice: 100.2, now: NOW });
    expect(ok.ok).toBe(true);
  });

  it('blocks a reversal >20% of risk against the side (LONG + SHORT mirrors)', () => {
    const longBad = preEntryRecheck({ row: row(), side: 'LONG', livePrice: 99.7, now: NOW });
    expect(longBad.ok).toBe(false);
    expect(longBad.state).toBe('REVERSAL');
    expect(longBad.metrics.adverseRatio).toBeCloseTo(0.3, 3);

    const shortRow = row({
      side: 'SHORT', plan: { entry: 100, stopLoss: 101, t1: 99, t2: 98 },
      directionVerified: true,
    });
    const shortBad = preEntryRecheck({ row: shortRow, side: 'SHORT', livePrice: 100.3, now: NOW });
    expect(shortBad.ok).toBe(false);
    expect(shortBad.state).toBe('REVERSAL');
  });

  it('blocks ≥0.75×ATR adverse and warns (CAUTION) at ≥0.5×ATR', () => {
    const wide = row({ plan: { entry: 100, stopLoss: 90, t1: 110, t2: 120 }, context: { atrPct: 1 } });
    const weak = preEntryRecheck({ row: wide, side: 'LONG', livePrice: 99.2, now: NOW });
    expect(weak.ok).toBe(false);
    expect(weak.state).toBe('WEAKENING');
    expect(weak.blockers.join(' ')).toMatch(/0\.80×ATR|0.8×ATR/);

    const caution = preEntryRecheck({ row: wide, side: 'LONG', livePrice: 99.4, now: NOW });
    expect(caution.ok).toBe(true);
    expect(caution.state).toBe('CAUTION');
    expect(caution.warnings.join(' ')).toMatch(/ATR against/i);
  });

  it('blocks a structure break after the trigger level is lost (wick buffer respected)', () => {
    const r = row({ triggerFired: true, plan: { entry: 100, stopLoss: 90, t1: 110, t2: 120, triggerLevel: 99.8 }, context: { atrPct: 1 } });
    const broke = preEntryRecheck({ row: r, side: 'LONG', livePrice: 99.7, now: NOW });
    expect(broke.ok).toBe(false);
    expect(broke.state).toBe('STRUCTURE_BREAK');
    expect(broke.blockers.join(' ')).toMatch(/lost trigger level/i);

    // Inside the 0.05×ATR buffer → not a break.
    const wick = preEntryRecheck({ row: r, side: 'LONG', livePrice: 99.77, now: NOW });
    expect(wick.state).not.toBe('STRUCTURE_BREAK');
  });

  it('blocks when a target has already been touched', () => {
    const out = preEntryRecheck({ row: row(), side: 'LONG', livePrice: 101.1, now: NOW });
    expect(out.ok).toBe(false);
    expect(out.state).toBe('TARGET_DONE');
    expect(out.blockers.join(' ')).toMatch(/target already T[12] touched/i);
  });

  it('blocks MTF↔DEEP HOLD / STAND_ASIDE / CONFLICT and an opposite deep side', () => {
    const hold = preEntryRecheck({
      row: row({ finalVerdict: { alignment: 'ALIGNED', decision: 'HOLD', reason: 'deep SVA veto' } }),
      side: 'LONG', livePrice: 100, now: NOW,
    });
    expect(hold.ok).toBe(false);
    expect(hold.blockers.join(' ')).toMatch(/combined verdict HOLD/);

    const aside = preEntryRecheck({
      row: row({ finalVerdict: { alignment: 'CONFLICT', decision: 'STAND_ASIDE', deep: { side: 'SHORT' } } }),
      side: 'LONG', livePrice: 100, now: NOW,
    });
    expect(aside.ok).toBe(false);
    expect(aside.blockers.join(' ')).toMatch(/engine conflict|STAND_ASIDE/);

    const opposite = preEntryRecheck({
      row: row({ finalVerdict: { alignment: 'PARTIAL', decision: 'ARMED', deep: { side: 'SHORT' } } }),
      side: 'LONG', livePrice: 100, now: NOW,
    });
    expect(opposite.ok).toBe(false);
    expect(opposite.blockers.join(' ')).toMatch(/deep ensemble SHORT vs execution LONG/);
  });

  it('blocks already-stamped trap/zone/reversal/flow/post-peak/overextended vetoes', () => {
    const cases = [
      [{ trapVeto: true }, /trap veto/i],
      [{ zoneWallVeto: true }, /zone wall/i],
      [{ reversalRisk: true }, /reversal/i],
      [{ trigger: { opposingFlow: true } }, /opposing flow/i],
      [{ trigger: { postPeakTrap: true } }, /post-peak/i],
      [{ trigger: { overextended: true } }, /overextended/i],
    ] as const;
    for (const [over, re] of cases) {
      const out = preEntryRecheck({ row: row(over as any), side: 'LONG', livePrice: 100, now: NOW });
      expect(out.ok).toBe(false);
      expect(out.blockers.join(' ')).toMatch(re);
    }
  });

  it('requires PAKKA direction only when asked; closed-bar side flip is always a veto', () => {
    const unverified = row({ directionVerified: false, directionVerdict: 'WAIT-LONG' });
    expect(preEntryRecheck({ row: unverified, side: 'LONG', livePrice: 100, now: NOW }).ok).toBe(true);
    const required = preEntryRecheck({ row: unverified, side: 'LONG', livePrice: 100, now: NOW, requireVerified: true });
    expect(required.ok).toBe(false);
    expect(required.blockers.join(' ')).toMatch(/not PAKKA verified/i);

    const flip = preEntryRecheck({ row: row({ barConfirmation: { sideStable: false } }), side: 'LONG', livePrice: 100, now: NOW });
    expect(flip.ok).toBe(false);
    expect(flip.blockers.join(' ')).toMatch(/closed-bar reversal/i);
  });

  it('blocks row-side vs execution-side disagreement and incomplete tickets', () => {
    const disagreement = preEntryRecheck({ row: row(), side: 'SHORT', livePrice: 100, now: NOW });
    expect(disagreement.ok).toBe(false);
    expect(disagreement.blockers.join(' ')).toMatch(/direction disagreement/i);
    const incomplete = preEntryRecheck({ row: row({ plan: { entry: 100 } }), side: 'LONG', livePrice: 100, now: NOW });
    expect(incomplete.ok).toBe(false);
    expect(incomplete.state).toBe('NO_PLAN');
  });

  it('missing live price fails OPEN (warn only — a gap is not a contradiction)', () => {
    const out = preEntryRecheck({ row: row(), side: 'LONG', livePrice: null, now: NOW });
    expect(out.ok).toBe(true);
    expect(out.warnings.join(' ')).toMatch(/live price unavailable/i);
  });
});

// ------------------------------------------------------------
// Auto-tick wiring
// ------------------------------------------------------------
function fakePaper() {
  const calls: any = { opened: [], closed: [] };
  const paper: any = {
    open: [],
    openPaperTrade: vi.fn((input: any) => {
      calls.opened.push(input);
      const trade = { id: 900 + calls.opened.length, ...input, status: 'OPEN' };
      paper.open.push({ id: trade.id, symbol: input.symbol, market: input.market, status: 'OPEN', direction: input.direction, openedAt: NOW });
      return { ok: true, trade };
    }),
    closePaperTrade: vi.fn((id: any) => {
      calls.closed.push(id);
      paper.open = paper.open.filter((t: any) => t.id !== id);
      return { ok: true, trade: { id, realizedPnl: -0.4 } };
    }),
    getPaperSummary: vi.fn(() => ({ open: paper.open })),
  };
  return { paper, calls };
}

function cleanBoard(over: any = {}) {
  return {
    ok: true, market: 'CRYPTO', mode: 'INTRADAY', holdMin: 45, minScore: 75,
    rows: [{
      ok: true, symbol: 'BTCUSDT', market: 'CRYPTO', mode: 'INTRADAY', label: '15m → 5m', holdMin: 45,
      superScore: 84, tier: 'STRONG', side: 'LONG', dir: 1, grade: 'A',
      directionVerified: true, directionVerdict: 'VERIFIED',
      triggerFired: true, dualAligned: true, counterTrend: false, tfFit: 'OK',
      autoEligible: true, autoBlockers: [],
      plan: { entry: 100, stopLoss: 99, t1: 101, t2: 102 },
      // SL = 1% and ATR = 0.5% → 2× ATR stop, passes the entry-quality floor.
      context: { regime: 'TREND_UP', adx: 25, rsi: 62, dir: 1, atrPct: 0.5 },
      trigger: { rsi: 62, dir: 1, pullbackReclaim: true },
      barConfirmation: { stable: true },
      ...over,
    }],
  };
}

function tick(paper: any, board: any, over: any = {}) {
  return {
    boards: { CRYPTO: board },
    paper,
    quotes: { BTCUSDT: { price: 100 }, BTC: { price: 100 } },
    walletEquityINR: 10000,
    now: NOW,
    ...over,
  };
}

describe('v21.38.0 — auto tick enforcement + parity', () => {
  beforeEach(() => { __resetMtfAutoForTests(); __resetDirectionLocksForTests(); });

  it('default paperLiveParity is ON and exposed in guard telemetry', () => {
    const cfg = loadMtfAutoConfig();
    expect(cfg.paperLiveParity).toBe(true);
    const st = mtfAutoStatus();
    expect(st.guards.modes.preEntryRecheck).toBe('enforce');
    expect(st.guards.paperLiveParity).toBe(true);
    expect(st.guards.scopes.preEntryRecheck).toBe('all');
    expect(st.guards.thresholds.preEntryMaxChaseRiskRatio).toBeLessThanOrEqual(0.25);
  });

  it('enforce blocks a 30%-past-entry paper chase before sizing (timing guard alone allowed 35%)', async () => {
    __resetMtfAutoForTests({
      config: {
        enabled: true, executionMode: 'paper', desks: { india: false, crypto: true },
        // v21.44.0: pin the legacy any-veto-blocks contract; the default
        // consensus mode is covered in entryQualityConsensusV21440.test.ts.
        entryQualityConsensus: 'single',
        // v21.44.2: the lean lane (default ON) forces the consensus shadow,
        // so this LEGACY off-path lock runs with lean disabled.
        leanEntryLane: false,
      },
    });
    const { paper, calls } = fakePaper();
    const out = await mtfAutoTick(tick(paper, cleanBoard(), {
      quotes: { BTCUSDT: { price: 100.3 }, BTC: { price: 100.3 } },
    }));
    expect(out.opened).toHaveLength(0);
    expect(calls.opened).toHaveLength(0);
    expect(out.skipped.join(' ')).toMatch(/entry quality consensus blocked \(1\/2\).*late chase/i);
    const st = mtfAutoStatus();
    expect(st.events.some((e: any) => e.kind === 'entry-quality-block')).toBe(true);
  });

  it('shadow records the would-block but still opens the paper trade', async () => {
    __resetMtfAutoForTests({
      config: { enabled: true, executionMode: 'paper', preEntryRecheck: 'shadow', desks: { india: false, crypto: true } },
    });
    const { paper, calls } = fakePaper();
    const out = await mtfAutoTick(tick(paper, cleanBoard(), {
      quotes: { BTCUSDT: { price: 100.3 }, BTC: { price: 100.3 } },
    }));
    expect(out.opened).toHaveLength(1);
    expect(calls.opened).toHaveLength(1);
    expect((out as any).shadow?.some((s: any) => s.warnings?.some((w: any) => w.filter === 'preEntryRecheck'))).toBe(true);
  });

  it('paper parity blocks an unverified-direction paper row (live gate parity)', async () => {
    __resetMtfAutoForTests({
      config: { enabled: true, executionMode: 'paper', desks: { india: false, crypto: true } },
    });
    const { paper, calls } = fakePaper();
    // undefined (not false) is the real "verification pending" shape: the
    // candidate stage lets it through, the parity gate must stop it.
    const board = cleanBoard({ directionVerified: undefined, directionVerdict: 'WAIT-LONG' });
    const out = await mtfAutoTick(tick(paper, board));
    expect(out.opened).toHaveLength(0);
    expect(calls.opened).toHaveLength(0);
    expect(out.skipped.join(' ')).toMatch(/pre-entry recheck blocked — direction not PAKKA verified/i);
  });

  it('paper parity runs the live entry-quality veto (noise stop + fading momentum)', async () => {
    __resetMtfAutoForTests({
      config: {
        enabled: true, executionMode: 'paper', desks: { india: false, crypto: true },
        // v21.44.0: pin the legacy single-veto contract.
        entryQualityConsensus: 'single',
        // v21.44.2: legacy off-path lock — lean (default ON) would shadow it.
        leanEntryLane: false,
      },
    });
    const { paper, calls } = fakePaper();
    const board = cleanBoard({
      // SL 1% with 1% ATR = 1.0× ATR (< 1.1 floor) and a fading 1-bar ROC.
      context: { regime: 'TREND_UP', adx: 25, rsi: 62, dir: 1, atrPct: 1 },
      trigger: { rsi: 62, dir: 1, pullbackReclaim: true, roc1: -0.1, roc3: -0.2 },
    });
    const out = await mtfAutoTick(tick(paper, board));
    expect(out.opened).toHaveLength(0);
    expect(calls.opened).toHaveLength(0);
    expect(out.skipped.join(' ')).toMatch(/entry quality consensus blocked \(1\/2\).*ATR < 1\.1× floor.*FADING/i);
  });

  it('paperLiveParity:false restores the legacy paper-exempt lane', async () => {
    __resetMtfAutoForTests({
      config: {
        enabled: true, executionMode: 'paper', paperLiveParity: false,
        desks: { india: false, crypto: true },
      },
    });
    const { paper, calls } = fakePaper();
    const board = cleanBoard({ directionVerified: undefined, directionVerdict: 'WAIT-LONG' });
    const out = await mtfAutoTick(tick(paper, board));
    expect(out.opened).toHaveLength(1);
    expect(calls.opened).toHaveLength(1);
  });
});

// ------------------------------------------------------------
// MTF ↔ DEEP combined verdict enforcement
// ------------------------------------------------------------
const gateRow = (over: any = {}) => ({
  ok: true, symbol: 'BTCUSDT', market: 'CRYPTO', mode: 'INTRADAY', holdMin: 45,
  superScore: 84, tier: 'STRONG', side: 'LONG', dir: 1, grade: 'A',
  directionVerified: true, directionVerdict: 'VERIFIED',
  triggerFired: true, dualAligned: true, counterTrend: false, tfFit: 'OK',
  ensembleSignalAvailable: true,
  autoEligible: true, autoBlockers: [],
  plan: { entry: 100, stopLoss: 99, t1: 101, t2: 102 },
  ...over,
});
const mainSignal = { side: 'LONG', grade: 'STRONG', confidence: 82, signalAge: { ageMs: 10 * 60_000 } };

describe('v21.38.0 — MTF↔DEEP combined verdict veto', () => {
  it('mtfProEntryGate passes the base row and blocks HOLD / STAND_ASIDE / opposite deep', () => {
    expect(mtfProEntryGate(gateRow(), { mainSignal }).ok).toBe(true);

    const hold = mtfProEntryGate(
      gateRow({ finalVerdict: { alignment: 'ALIGNED', decision: 'HOLD', reason: 'SVA veto' } }),
      { mainSignal },
    );
    expect(hold.ok).toBe(false);
    expect(hold.blockers.join(' ')).toMatch(/combined verdict HOLD/);

    const aside = mtfProEntryGate(
      gateRow({ finalVerdict: { alignment: 'CONFLICT', decision: 'STAND_ASIDE' } }),
      { mainSignal },
    );
    expect(aside.ok).toBe(false);
    expect(aside.blockers.join(' ')).toMatch(/combined verdict STAND_ASIDE/);

    const opposite = mtfProEntryGate(
      gateRow({ finalVerdict: { alignment: 'PARTIAL', decision: 'ARMED', deep: { side: 'SHORT' } } }),
      { mainSignal },
    );
    expect(opposite.ok).toBe(false);
    expect(opposite.blockers.join(' ')).toMatch(/deep ensemble SHORT/);
  });

  it('dualAutoCandidates marks HOLD rows ineligible with the exact reason', () => {
    const base = dualAutoCandidates([gateRow()], { minScore: 75 }, { now: NOW });
    expect(base[0].autoPickBlockers).toEqual([]);

    const hold = dualAutoCandidates(
      [gateRow({ finalVerdict: { alignment: 'ALIGNED', decision: 'HOLD' } })],
      { minScore: 75 }, { now: NOW },
    );
    expect(hold[0].autoPickBlockers.join(' ')).toMatch(/combined verdict HOLD/);

    const aside = dualAutoCandidates(
      [gateRow({ finalVerdict: { alignment: 'CONFLICT', decision: 'STAND_ASIDE' } })],
      { minScore: 75 }, { now: NOW },
    );
    expect(aside[0].autoPickBlockers.join(' ')).toMatch(/combined verdict STAND_ASIDE/);
  });
});

// ------------------------------------------------------------
// Realtime recheck: real ATR + structure states
// ------------------------------------------------------------
describe('v21.38.0 — signal recheck real ATR + structure', () => {
  const chk = (over: any = {}) => ({
    side: 'LONG', entry: 100, stopLoss: 90, target1: 110, target2: 120,
    triggerFired: false, atrPct: 1, ...over,
  });

  it('uses atrPct instead of the old 1.2% fallback (0.6×ATR = CAUTION, 0.8×ATR = WEAKENING)', () => {
    expect(recheckRow(chk(), 99.4).state).toBe('CAUTION');
    expect(recheckRow(chk(), 99.2).state).toBe('WEAKENING');
    // Legacy 1.2% fallback would have called both OK.
    expect(recheckRow(chk({ atrPct: null }), 99.2).state).toBe('OK');
  });

  it('emits STRUCTURE_BREAK when the fired trigger level is lost', () => {
    const r = recheckRow(chk({ triggerFired: true, triggerLevel: 99.8, atrPct: 1 }), 99.7);
    expect(r.state).toBe('STRUCTURE_BREAK');
    expect(r.reason).toMatch(/trigger level 99.8 lost/i);
    // Inside the wick buffer → no structure event.
    expect(recheckRow(chk({ triggerFired: true, triggerLevel: 99.8, atrPct: 1 }), 99.77).state).not.toBe('STRUCTURE_BREAK');
  });

  it('CAUTION recovers to OK and the transition is reportable', () => {
    expect(priceStateTransition('CAUTION', 'OK')).toBe('RECOVERED');
    expect(priceStateTransition('OK', 'CAUTION')).toBeNull();
    expect(priceStateTransition('OK', 'STRUCTURE_BREAK')).toBe('STRUCTURE_BREAK');
  });
});

// ------------------------------------------------------------
// Source pins (manual routes + tick placement)
// ------------------------------------------------------------
describe('v21.38.0 — wiring pins', () => {
  const root = process.cwd();
  const autoSrc = fs.readFileSync(path.join(root, 'server/ai/mtfAutoLink.js'), 'utf8');
  const routesSrc = fs.readFileSync(path.join(root, 'server/ai/routes.js'), 'utf8');

  it('auto tick runs the pre-entry gate BEFORE the fidelity/churn block', () => {
    expect(autoSrc).toContain("import { preEntryRecheck, measuredRowAtr } from './preEntryGate.js';");
    expect(autoSrc).toContain('const pre = preEntryRecheck({');
    expect(autoSrc).toContain('pre-entry recheck blocked');
    expect(autoSrc).toContain('preEntryRecheck: \'enforce\'');
    expect(autoSrc).toContain('paperLiveParity: true');
    const gateAt = autoSrc.indexOf('const pre = preEntryRecheck({');
    const fidelityAt = autoSrc.indexOf('const fidApplies = parity || gateScopeApplies');
    expect(gateAt).toBeGreaterThan(-1);
    expect(fidelityAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(fidelityAt);
  });

  it('both manual board routes enforce the same gate', () => {
    expect(routesSrc).toContain("import { preEntryRecheck } from './preEntryGate.js';");
    expect(routesSrc).toContain('const mtfPreEntryVerdict = async');
    const paperAt = routesSrc.indexOf("app.post('/api/ai/mtf-dual/paper'");
    const liveAt = routesSrc.indexOf("app.post('/api/ai/mtf-dual/live'");
    const callAt = routesSrc.indexOf('await mtfPreEntryVerdict({ row, side: normalizeSide(row.side), market })');
    const liveCallAt = routesSrc.indexOf('await mtfPreEntryVerdict({ row, side, market })');
    expect(paperAt).toBeGreaterThan(-1);
    expect(callAt).toBeGreaterThan(paperAt);
    expect(liveCallAt).toBeGreaterThan(liveAt);
    expect(routesSrc).toContain('pre-entry recheck:');
  });
});

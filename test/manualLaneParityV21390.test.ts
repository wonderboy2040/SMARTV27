// ============================================================
// test/manualLaneParityV21390.test.ts — v21.39.0
// MANUAL BOARD LANE PARITY — the 17 Nov paper-loss root cause.
// ------------------------------------------------------------
// Evidence from the live paper ledger (63 trades / 60 closed):
//   • 17 Nov: 5/5 closed losses + 3/3 open losses, ALL `mtf-board-ui`
//   • auto lane logged `paper-entry-veto | AVAX: ... stop 0.69% =
//     0.77× ATR < 1.1× floor` — the manual button opened it anyway
//   • manual paper rows carried no directionVerified / entryGate audit
//   • `consecutiveLossState(liveOnly:true)` → 5 paper losses never paused
//   • 3 manual paper trades open while maxOpenPositions = 1
//
// This suite locks the fix: the SAME pure evaluators the auto tick uses
// now run for a manual click, under `paperLiveParity` (default ON).
// ============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const TMP_MTF = fs.mkdtempSync(path.join(os.tmpdir(), 'mtf-manual-parity-'));
process.env.MTF_AUTO_DATA_DIR = TMP_MTF;
process.env.SIGNAL_FIDELITY = '';
process.env.LOSS_CHURN_LOCK = '';

vi.mock('../server/mcp/durable.js', () => ({
  durablePut: vi.fn(),
  decryptJSON: vi.fn(),
}));

import {
  evaluateManualEntryGates,
  loadMtfAutoConfig,
  mtfAutoRiskArmState,
  __resetMtfAutoForTests,
} from '../server/ai/mtfAutoLink.js';
import { openPaperTrade, _resetForTests as __resetPaperForTests } from '../server/intraday/paperTrading.js';

const NOW = Date.now();

const BASE_CFG = {
  enabled: true,
  executionMode: 'paper',
  paperLiveParity: true,
  maxOpenPositions: 1,
  multiTradeMode: false,
  maxConcurrentTrades: 3,
  consecutiveLossPauseAfter: 3,
  consecutiveLossPauseMin: 120,
  // Isolated in most tests: only the test that names a gate turns it on.
  signalFidelity: 'off',
  lossChurnLock: 'off',
};

function seed(over: Record<string, unknown> = {}, state: Record<string, unknown> | null = null) {
  __resetMtfAutoForTests({
    config: { ...BASE_CFG, ...over },
    ...(state ? { state } : {}),
  });
  return loadMtfAutoConfig();
}

/** Clean AVAX-short board row: verified direction, stop = 2.5× ATR. */
function cleanRow(over: Record<string, unknown> = {}) {
  return {
    symbol: 'AVAX',
    market: 'CRYPTO',
    side: 'SHORT',
    tier: 'ELITE',
    superScore: 99,
    directionVerified: true,
    directionVerdict: 'VERIFIED',
    triggerFired: true,
    regime: 'TREND_DOWN',
    family: 'TREND',
    plan: { entry: 30, stopLoss: 30.3, t1: 29.4, t2: 28.8 },
    context: { atrPct: 0.4 },
    trigger: { roc1: -0.05, roc3: -0.2, volRatio: 1.1 }, // in-direction = STEADY
    ...over,
  };
}

/** The exact 17 Nov AVAX geometry: 0.69% stop = 0.77× ATR. */
function avaxNoiseRow(over: Record<string, unknown> = {}) {
  return cleanRow({
    plan: { entry: 30, stopLoss: 30.207, t1: 29.4, t2: 28.8 },
    context: { atrPct: 0.9 },
    ...over,
  });
}

function closedRow(over: Record<string, unknown> = {}) {
  return {
    status: 'CLOSED',
    executionMode: 'PAPER',
    openedBy: 'AUTO',
    symbol: 'AVAX',
    side: 'SHORT',
    market: 'CRYPTO',
    entry: 30,
    stopLoss: 30.3,
    pnl: -1,
    closeReason: 'SL_HIT',
    closedAt: NOW - 5 * 60_000,
    ...over,
  };
}

function openPaperRow(over: Record<string, unknown> = {}) {
  return {
    status: 'OPEN',
    executionMode: 'PAPER',
    paperId: 900,
    traded: true,
    openedBy: 'MANUAL',
    symbol: 'BTC',
    side: 'LONG',
    market: 'CRYPTO',
    entry: 100,
    stopLoss: 99,
    openedAt: NOW - 60_000,
    ...over,
  };
}

const gate = (cfg: any, over: Record<string, unknown> = {}) => evaluateManualEntryGates({
  row: cleanRow(),
  side: 'SHORT',
  market: 'CRYPTO',
  lane: 'PAPER',
  entry: 30,
  stopLoss: 30.3,
  atrPct: 0.4,
  cfg,
  now: NOW,
  ...over,
});

// ------------------------------------------------------------
// A) entry quality — the exact AVAX ticket the auto lane vetoed
// ------------------------------------------------------------
describe('manual parity — entry quality (ATR stop floor + FADING)', () => {
  it('v21.44.1 — 17 Nov AVAX geometry: a lone noise-stop-out quality veto now WARNS (no block)', () => {
    const cfg = seed();
    const row = avaxNoiseRow();
    const out = gate(cfg, { row, entry: 30, stopLoss: 30.207, atrPct: 0.9 });
    // direction is PAKKA + no hard contradiction → entry opens; the soft
    // noise stop-out is quality evidence logged as a warning, not a blocker.
    expect(out.ok).toBe(true);
    expect(out.warnings.some((w: any) => w.filter === 'entryQuality' && /noise stop-out/.test(w.reason))).toBe(true);
    expect(out.telemetry.entryQuality.slAtrMult).toBeLessThan(1.1);
  });

  it('v21.44.1 — a FADING momentum entry is a lone quality WARN (no block)', () => {
    const cfg = seed();
    const row = cleanRow({ trigger: { roc1: 0.05, roc3: 0.1, volRatio: 1.2 } }); // SHORT + rising = FADING
    const out = gate(cfg, { row, entry: 30, stopLoss: 30.3, atrPct: 0.4 });
    expect(out.ok).toBe(true);
    expect(out.warnings.some((w: any) => w.filter === 'entryQuality' && /momentum FADING/i.test(w.reason))).toBe(true);
    expect(out.telemetry.entryQuality.momentumState).toBe('FADING');
  });

  it('passes a wide-stop in-direction entry', () => {
    const cfg = seed();
    const out = gate(cfg);
    expect(out.ok).toBe(true);
    expect(out.telemetry.entryQuality.slAtrMult).toBeGreaterThan(1.1);
  });

  it('paperLiveParity:false restores the old paper-exempt lane', () => {
    const cfg = seed({ paperLiveParity: false });
    const row = avaxNoiseRow({ directionVerified: false });
    const out = gate(cfg, { row, entry: 30, stopLoss: 30.207, atrPct: 0.9 });
    expect(out.ok).toBe(true);
    expect(out.telemetry.parity).toBe(false);
  });
});

// ------------------------------------------------------------
// B) PAKKA direction — parity extends the live requirement
// ------------------------------------------------------------
describe('manual parity — direction certificate', () => {
  it('blocks an unverified direction under parity', () => {
    const cfg = seed();
    const out = gate(cfg, { row: cleanRow({ directionVerified: false, directionVerdict: 'WAIT-SHORT' }) });
    expect(out.ok).toBe(false);
    expect(out.blockers.join(' ')).toMatch(/PAKKA verified/);
  });

  it('null directionVerified is unverified (no silent true)', () => {
    const cfg = seed();
    const out = gate(cfg, { row: cleanRow({ directionVerified: null }) });
    expect(out.ok).toBe(false);
    expect(out.blockers.join(' ')).toMatch(/PAKKA verified/);
  });
});

// ------------------------------------------------------------
// C) signal fidelity — CHOP has no directional follow-through
// ------------------------------------------------------------
describe('manual parity — signal fidelity', () => {
  it('v21.44.1 — CHOP-regime fidelity veto is a lone quality WARN (no block)', () => {
    const cfg = seed({ signalFidelity: 'enforce' });
    const out = gate(cfg, { row: cleanRow({ regime: 'CHOP' }) });
    // a single quality gate only warns; two distinct gates (or a forced
    // extreme ratio) would block. Telemetry still records the would-block.
    expect(out.ok).toBe(true);
    expect(out.warnings.some((w: any) => w.filter === 'signalFidelity' && /CHOP/.test(w.reason))).toBe(true);
    expect(out.telemetry.fidelity?.wouldBlock).toBe(true);
  });

  it('shadow mode records telemetry without blocking', () => {
    const cfg = seed({ signalFidelity: 'shadow' });
    const out = gate(cfg, { row: cleanRow({ regime: 'CHOP' }) });
    expect(out.ok).toBe(true);
    expect(out.telemetry.fidelity.wouldBlock).toBe(true);
    expect(out.telemetry.fidelity.mode).toBe('shadow');
  });
});

// ------------------------------------------------------------
// D) loss-churn lock — the BNB → BTC → DOGE re-entry pattern
// ------------------------------------------------------------
describe('manual parity — loss-churn lock', () => {
  it('locks the same side after a fresh manual paper loss', () => {
    const cfg = seed(
      { lossChurnLock: 'enforce', lossChurnCooldownMin: 20 },
      { book: [closedRow({ openedBy: 'MANUAL' })] },
    );
    const out = gate(cfg);
    expect(out.ok).toBe(false);
    expect(out.blockers.join(' ')).toMatch(/loss-churn lock/);
    expect(out.telemetry.churn.wouldLock).toBe(true);
  });

  it('does not lock the opposite side for a single loss', () => {
    const cfg = seed(
      { lossChurnLock: 'enforce' },
      { book: [closedRow({ side: 'SHORT' })] },
    );
    const out = gate(cfg, {
      row: cleanRow({ side: 'LONG', trigger: { roc1: 0.05, roc3: 0.2, volRatio: 1.1 } }),
      side: 'LONG', entry: 30, stopLoss: 29.7,
    });
    expect(out.ok).toBe(true);
  });
});

// ------------------------------------------------------------
// E) consecutive-loss pause — paper closes must count under parity
// ------------------------------------------------------------
describe('manual parity — paper loss-streak pause', () => {
  const threePaperLosses = () => ([
    closedRow({ closedAt: NOW - 3 * 60_000 }),
    closedRow({ closedAt: NOW - 4 * 60_000 }),
    closedRow({ closedAt: NOW - 5 * 60_000 }),
  ]);

  it('3 consecutive PAPER losses pause new PAPER entries', () => {
    const cfg = seed({}, { book: threePaperLosses() });
    const out = gate(cfg);
    expect(out.ok).toBe(false);
    expect(out.blockers.join(' ')).toMatch(/consecutive-loss pause/);
    expect(out.telemetry.lossPause.streak).toBe(3);
  });

  it('LIVE losses do not count against the PAPER lane', () => {
    const cfg = seed({}, {
      book: threePaperLosses().map(r => ({ ...r, executionMode: 'LIVE' })),
    });
    const out = gate(cfg);
    expect(out.ok).toBe(true);
    expect(out.telemetry.lossPause.streak).toBe(0);
  });

  it('parity off keeps paper exempt (old liveOnly behaviour)', () => {
    const cfg = seed({ paperLiveParity: false }, { book: threePaperLosses() });
    const out = gate(cfg);
    expect(out.ok).toBe(true);
  });

  it('status exposes the paper streak separately from the LIVE streak', () => {
    const cfg = seed({}, { book: threePaperLosses() });
    const arm = mtfAutoRiskArmState(cfg);
    expect(arm.consecutiveLoss.streak).toBe(0);       // LIVE lane untouched
    expect(arm.consecutiveLossPaper.streak).toBe(3);  // PAPER lane honest
    expect(arm.consecutiveLossPaper.blocked).toBe(true);
  });
});

// ------------------------------------------------------------
// F) concurrency — manual clicks respect the book cap
// ------------------------------------------------------------
describe('manual parity — open-position cap', () => {
  it('maxOpenPositions=1 blocks a second manual PAPER entry', () => {
    const cfg = seed({}, { book: [openPaperRow()] });
    const out = gate(cfg, { row: cleanRow({ symbol: 'ETH' }) });
    expect(out.ok).toBe(false);
    expect(out.blockers.join(' ')).toMatch(/max open PAPER positions 1\/1/);
  });

  it('multi-trade mode raises the cap to maxConcurrentTrades', () => {
    const cfg = seed({ multiTradeMode: true, maxConcurrentTrades: 3 }, { book: [openPaperRow()] });
    const out = gate(cfg, { row: cleanRow({ symbol: 'ETH' }) });
    expect(out.ok).toBe(true);
    expect(out.telemetry.caps).toMatchObject({ open: 1, cap: 3, multiTrade: true });
  });

  it('LIVE rows do not consume the PAPER cap', () => {
    const cfg = seed({}, { book: [openPaperRow({ executionMode: 'LIVE', livePositionId: 'pos-1' })] });
    const out = gate(cfg, { row: cleanRow({ symbol: 'ETH' }) });
    expect(out.ok).toBe(true);
  });
});

// ------------------------------------------------------------
// G) LIVE lane uses the same evaluators (no paper-only drift)
// ------------------------------------------------------------
describe('manual parity — LIVE lane', () => {
  const liveGate = (cfg: any, over: Record<string, unknown> = {}) => evaluateManualEntryGates({
    row: cleanRow(),
    side: 'SHORT',
    market: 'CRYPTO',
    lane: 'LIVE',
    entry: 30,
    stopLoss: 30.3,
    atrPct: 0.4,
    cfg,
    now: NOW,
    ...over,
  });

  it('passes a clean verified row', () => {
    const cfg = seed();
    const out = liveGate(cfg);
    expect(out.ok).toBe(true);
    expect(out.lane).toBe('LIVE');
  });

  it('v21.44.1 — LIVE lane: AVAX noise stop + FADING momentum are quality WARNS (no block)', () => {
    const cfg = seed();
    const out = liveGate(cfg, {
      row: avaxNoiseRow({ trigger: { roc1: 0.05, roc3: 0.1, volRatio: 1.2 } }),
      entry: 30, stopLoss: 30.207, atrPct: 0.9,
    });
    // both soft evidences ride the same entryQuality gate (one distinct
    // vote) → warns under the measure-first default; direction PAKKA holds.
    expect(out.ok).toBe(true);
    expect(out.warnings.some((w: any) => w.filter === 'entryQuality' && /noise stop-out/.test(w.reason))).toBe(true);
    expect(out.warnings.some((w: any) => w.filter === 'entryQuality' && /momentum FADING/i.test(w.reason))).toBe(true);
  });
});

// ------------------------------------------------------------
// H) wiring — both manual routes + paper ticket audit
// ------------------------------------------------------------
describe('manual parity — route + audit wiring', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  it('both board buttons call the shared gate composer', () => {
    const src = read('server/ai/routes.js');
    const paperAt = src.indexOf("app.post('/api/ai/mtf-dual/paper'");
    const liveAt = src.indexOf("app.post('/api/ai/mtf-dual/live'");
    expect(paperAt).toBeGreaterThan(-1);
    expect(liveAt).toBeGreaterThan(paperAt);
    const paperRoute = src.slice(paperAt, liveAt);
    const liveRoute = src.slice(liveAt, src.indexOf('app.post(', liveAt + 10));
    expect(paperRoute).toContain('evaluateManualEntryGates({');
    expect(paperRoute).toContain("lane: 'PAPER'");
    expect(liveRoute).toContain('evaluateManualEntryGates({');
    expect(liveRoute).toContain("lane: 'LIVE'");
    // 409 + blockers surfaced (never a silent skip)
    expect(paperRoute).toContain('manual-lane parity:');
    expect(liveRoute).toContain('manual-lane parity:');
  });

  it('paper route stamps entry-time ATR so the quality gate has real data', () => {
    const src = read('server/ai/routes.js');
    const paperAt = src.indexOf("app.post('/api/ai/mtf-dual/paper'");
    const liveAt = src.indexOf("app.post('/api/ai/mtf-dual/live'");
    const paperRoute = src.slice(paperAt, liveAt);
    expect(paperRoute).toContain('atrPct: entryAtrPct');
    expect(paperRoute).toContain("entryGate: 'MANUAL_PARITY_V1'");
  });

  it('paperTrading keeps direction / gate / fidelity evidence in sourceMeta', () => {
    const src = read('server/intraday/paperTrading.js');
    expect(src).toContain('directionVerified: tri(src.directionVerified)');
    expect(src).toContain('entryGate: str(src.entryGate');
    expect(src).toContain('entryQuality: eq ?');
    expect(src).toContain('lossChurn: churn ?');
    expect(src).toContain('lossPause: pause ?');
  });
});

// ------------------------------------------------------------
// I) real paper engine — the audit fields survive persistence
// ------------------------------------------------------------
describe('paper ticket audit — openPaperTrade sourceMeta', () => {
  beforeEach(() => {
    __resetPaperForTests();
    seed();
  });

  it('persists atrPct + the manual-parity audit fields', () => {
    const out = openPaperTrade({
      symbol: 'AVAX',
      direction: 'SHORT',
      entry: 30,
      qty: 1,
      stopLoss: 30.3,
      target1: 29.4,
      target2: 28.8,
      market: 'FUTURES',
      source: 'mtf-board-ui',
      atrPct: 0.9,
      sourceMeta: {
        score: 99,
        tier: 'ELITE',
        mode: 'INTRADAY',
        holdMin: 45,
        directionVerified: true,
        directionVerdict: 'VERIFIED',
        triggerFired: true,
        orderSide: 'SELL',
        entryGate: 'MANUAL_PARITY_V1',
        preEntryState: 'OK',
        entryQuality: { blocked: false, slAtrMult: 2.5, atrPct: 0.9, momentumState: 'STEADY' },
        fidelity: { mode: 'enforce', wouldBlock: false, regime: 'TREND_DOWN', rsi: 40, adx: 25 },
        lossChurn: { mode: 'enforce', wouldLock: false, lossStreak: 0 },
        lossPause: { streak: 0, threshold: 3, blocked: false },
        // Must be dropped: no unbounded payloads / secrets in the ledger.
        apiKey: 'sk-must-not-persist',
      },
    });

    expect(out.ok).toBe(true);
    expect(out.trade.atrPct).toBe(0.9);
    expect(out.trade.sourceMeta).toMatchObject({
      score: 99,
      tier: 'ELITE',
      directionVerified: true,
      directionVerdict: 'VERIFIED',
      orderSide: 'SELL',
      entryGate: 'MANUAL_PARITY_V1',
      preEntryState: 'OK',
      entryQuality: { slAtrMult: 2.5, momentumState: 'STEADY' },
      fidelity: { mode: 'enforce', regime: 'TREND_DOWN', rsi: 40, adx: 25 },
      lossChurn: { mode: 'enforce', wouldLock: false, lossStreak: 0 },
      lossPause: { streak: 0, threshold: 3, blocked: false },
    });
    expect(out.trade.sourceMeta.apiKey).toBeUndefined();
  });
});

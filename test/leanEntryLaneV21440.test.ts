// ============================================================
// test/leanEntryLaneV21440.test.ts — v21.44.2 LEAN ENTRY LANE
// ------------------------------------------------------------
// Operator decision (2026-11-24): the live auto-trade lane stacks too
// many gates/checks and good signals aren't getting through. ONE switch
// (`leanEntryLane`, default ON) simplifies the entry lane:
//   • hard-safety stays blocking: direction-verified, SL/target not
//     done, row/quote freshness, trap/zone/reversal row flags, risk caps,
//     loss-churn, direction-lock, dedup, quotas;
//   • secondary quality gates (entry-timing, pre-entry-recheck quality,
//     signal-fidelity, MC-odds, breakout, late-wave, live-entry-quality,
//     + the consensus layer) run measure-only (shadow) — they still log,
//     they can never veto a clean signal;
//   • the candidate AND-bar relaxes: aiGuard>=2 / !trapVeto /
//     !zoneWallVeto / !counterTrend are dropped; the tier gate is
//     bypassed; the live floor widens 80 → 75 (ACTION tier enters).
// `leanEntryLane: false` (or MTF_LEAN_ENTRY_LANE=0) restores the full
// legacy gate stack byte-identically.
// ============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mtf-lean-lane-21440-'));
process.env.MTF_AUTO_DATA_DIR = TMP_DATA;

vi.mock('../server/mcp/durable.js', () => ({ durablePut: vi.fn() }));

import {
  mtfAutoTick, mtfAutoStatus, __resetMtfAutoForTests, loadMtfAutoConfig,
  MTF_AUTO_DEFAULTS, resolveLeanLaneModes, leanCandidateFilter,
  isStrongSignal,
} from '../server/ai/mtfAutoLink.js';
import { __resetDirectionLocksForTests } from '../server/ai/directionLock.js';

const NOW = 1_765_000_000_000;

function fakePaper() {
  const calls = { opened: [] };
  const paper = {
    open: [],
    openPaperTrade: vi.fn((input) => {
      calls.opened.push(input);
      const trade = { id: 900 + calls.opened.length, ...input };
      paper.open.push({ id: trade.id, symbol: input.symbol, market: input.market, status: 'OPEN', direction: input.direction, openedAt: Date.now() });
      return { ok: true, trade };
    }),
    closePaperTrade: vi.fn(() => ({ ok: true })),
    getPaperSummary: vi.fn(() => ({ open: paper.open })),
  };
  return { paper, calls };
}

// A clean ACTION-tier row (superScore 78) that legacy would REJECT:
// tier not STRONG/ELITE, aiGuard=1, counterTrend stamped, and superScore < 80
// (legacy live floor). None of these are hard-safety (trap/zone/reversal row
// flags stay hard at commit time), so the lean lane must admit + open it.
const actionRow = (over: Record<string, unknown> = {}) => ({
  ok: true, symbol: 'BTCUSDT', market: 'CRYPTO', mode: 'INTRADAY', label: '15m → 5m', holdMin: 45,
  superScore: 78, tier: 'ACTION', side: 'LONG', dir: 1, grade: 'A',
  directionVerified: true, directionVerdict: 'VERIFIED',
  triggerFired: true, dualAligned: true, counterTrend: true, tfFit: 'OK',
  aiGuard: { approvedCount: 1 },
  autoEligible: true, autoBlockers: [],
  plan: { entry: 100, stopLoss: 99, t1: 101, t2: 102 },
  ...over,
});

function tickP(paper: any, board: any, over: Record<string, unknown> = {}) {
  // NO `quotes` key on purpose: the tick's timing quote then falls back to the
  // row's own ltp (exactly the entryQualityConsensusV21440 fixture shape), so
  // target-touch / late-chase assertions key off the row's numbers.
  return {
    boards: { CRYPTO: board },
    paper,
    walletEquityINR: 10000,
    fx: 94.95,
    now: NOW,
    ...over,
  };
}

function leanBoard(over: Record<string, unknown> = {}) {
  return {
    ok: true, market: 'CRYPTO', mode: 'INTRADAY', holdMin: 45, minScore: 75,
    rows: [actionRow(over)],
  };
}

const baseLeanCfg = {
  enabled: true,
  executionMode: 'paper',
  desks: { india: false, crypto: true },
};

describe('v21.44.2 — lean-lane defaults + pure resolvers', () => {
  beforeEach(() => {
    __resetMtfAutoForTests();
    delete process.env.MTF_LEAN_ENTRY_LANE;
    delete process.env.MTF_AUTO_STRONG_ONLY;
  });

  it('leanEntryLane defaults ON; the persisted config picks it up (no key needed)', () => {
    expect(MTF_AUTO_DEFAULTS.leanEntryLane).toBe(true);
    const cfg = loadMtfAutoConfig();
    expect(cfg.leanEntryLane).toBe(true);
  });

  it('explicit false is honored; env MTF_LEAN_ENTRY_LANE=0 wins over config', () => {
    __resetMtfAutoForTests({ config: { leanEntryLane: false } });
    expect(loadMtfAutoConfig().leanEntryLane).toBe(false);
    expect(resolveLeanLaneModes().lean).toBe(false);
    // env kill-switch on a lean (default ON) config:
    __resetMtfAutoForTests({ config: baseLeanCfg });
    process.env.MTF_LEAN_ENTRY_LANE = '0';
    expect(resolveLeanLaneModes().lean).toBe(false);
    delete process.env.MTF_LEAN_ENTRY_LANE;
    expect(resolveLeanLaneModes().lean).toBe(true);
  });

  it('resolveLeanLaneModes matrix: lean forces every secondary gate shadow + floor 75', () => {
    __resetMtfAutoForTests({ config: baseLeanCfg });
    const lean = resolveLeanLaneModes();
    expect(lean.lean).toBe(true);
    expect(lean.consensusMode).toBe('shadow');
    expect(lean.mcMode).toBe('shadow');
    expect(lean.boMode).toBe('shadow');
    expect(lean.lwMode).toBe('shadow');
    expect(lean.fidMode).toBe('shadow');
    expect(lean.leanFloor).toBe(75);
  });

  it('legacy (lean:false) restores operator modes + null floor', () => {
    __resetMtfAutoForTests({
      config: { ...baseLeanCfg, leanEntryLane: false, entryQualityConsensus: 'single', mcOddsGate: 'enforce' },
    });
    const lane = resolveLeanLaneModes();
    expect(lane.lean).toBe(false);
    expect(lane.consensusMode).toBe('single');
    expect(lane.mcMode).toBe('enforce');
    expect(lane.leanFloor).toBeNull();
  });

  it('leanCandidateFilter: legacy lane applies all four vetoes; lean lane drops them', () => {
    const row = actionRow(); // aiGuard=1, trapVeto, counterTrend, tier ACTION
    // legacy: rejected by aiGuard AND trap AND counterTrend AND tier gate
    expect(leanCandidateFilter(row, { lean: false, strongOnly: true })).toBe(false);
    expect(leanCandidateFilter(row, { lean: false, strongOnly: false })).toBe(false);
    // lean: all four dropped — the row passes this layer
    expect(leanCandidateFilter(row, { lean: true, strongOnly: true })).toBe(true);
    expect(leanCandidateFilter(row, { lean: true, strongOnly: false })).toBe(true);
    // a clean STRONG row passes both lanes
    const strong = { ...actionRow({ superScore: 82, tier: 'STRONG', aiGuard: null, trapVeto: false, counterTrend: false }) };
    expect(isStrongSignal(strong)).toBe(true);
    expect(leanCandidateFilter(strong, { lean: false, strongOnly: true })).toBe(true);
    expect(leanCandidateFilter(strong, { lean: true, strongOnly: false })).toBe(true);
  });
});

describe('v21.44.2 — lean lane end-to-end (auto tick)', () => {
  beforeEach(() => {
    __resetMtfAutoForTests();
    delete process.env.MTF_LEAN_ENTRY_LANE;
    delete process.env.MTF_AUTO_STRONG_ONLY;
  });

  it('lean (default): a 78-point ACTION row with trap/counter-trend stamps OPENS', async () => {
    // autoStrongOnly defaults ON — legacy would filter this row out of the
    // pool entirely; lean bypasses the tier gate + widens the floor to 75.
    __resetMtfAutoForTests({ config: baseLeanCfg });
    const { paper, calls } = fakePaper();
    const out = await mtfAutoTick(tickP(paper, leanBoard()));
    expect(out.opened).toHaveLength(1);
    expect(calls.opened).toHaveLength(1);
    expect(out.skipped.join(' ')).not.toMatch(/STRONG\/ELITE gate/);
    expect(out.skipped.join(' ')).not.toMatch(/quality consensus blocked/);
  });

  it('lean: two distinct quality vetoes still do NOT block (measure-only)', async () => {
    __resetMtfAutoForTests({ config: baseLeanCfg });
    const { paper, calls } = fakePaper();
    // atr 1.5 vs 1% stop = noise stop-out (entryQuality) + ltp 100.3 → late
    // chase (preEntryRecheck): TWO distinct quality gates would-block.
    const out = await mtfAutoTick(tickP(paper, leanBoard({ ltp: 100.3, atr: 1.5 })));
    expect(out.opened).toHaveLength(1);
    expect(calls.opened).toHaveLength(1);
    expect(out.skipped.join(' ')).not.toMatch(/quality consensus blocked/);
    const w = out.shadow.flatMap((s: any) => s.warnings || []).map((x: any) => x.filter);
    expect(w).toContain('preEntryRecheck');
    expect(w).toContain('entryQuality');
  });

  it('lean OFF restores the legacy block on the same row (off-path lock)', async () => {
    __resetMtfAutoForTests({
      config: { ...baseLeanCfg, leanEntryLane: false, entryQualityConsensus: 'single' },
    });
    const { paper, calls } = fakePaper();
    const out = await mtfAutoTick(tickP(paper, leanBoard()));
    // legacy: pool drops the row (aiGuard=1 / trap / counterTrend / tier)
    expect(out.opened).toHaveLength(0);
    expect(calls.opened).toHaveLength(0);
    expect(out.skipped.join(' ')).toMatch(/STRONG\/ELITE gate|no ELITE\/STRONG/);
  });

  it('lean OFF + single-veto: the same two-gate veto blocks (legacy contract)', async () => {
    __resetMtfAutoForTests({
      config: {
        ...baseLeanCfg, leanEntryLane: false, entryQualityConsensus: 'single',
        // legacy lane still admits this row into the pool (aiGuard cleared,
        // tier STRONG, score 82) — only the quality-veto layer is exercised.
      },
    });
    const { paper, calls } = fakePaper();
    const out = await mtfAutoTick(tickP(paper, leanBoard({
      superScore: 82, tier: 'STRONG', aiGuard: null, trapVeto: false, counterTrend: false,
      ltp: 100.3, atr: 1.5,
    })));
    expect(out.opened).toHaveLength(0);
    expect(calls.opened).toHaveLength(0);
    expect(out.skipped.join(' ')).toMatch(/entry quality consensus blocked/);
  });

  it('hard safety still blocks in the lean lane: direction unverified', async () => {
    __resetMtfAutoForTests({ config: baseLeanCfg });
    const { paper, calls } = fakePaper();
    const out = await mtfAutoTick(tickP(paper, leanBoard({ directionVerified: undefined, directionVerdict: 'WAIT-LONG' })));
    expect(out.opened).toHaveLength(0);
    expect(calls.opened).toHaveLength(0);
    expect(out.skipped.join(' ')).toMatch(/direction not PAKKA verified/i);
  });

  it('hard safety still blocks in the lean lane: target already touched', async () => {
    __resetMtfAutoForTests({ config: baseLeanCfg });
    const { paper, calls } = fakePaper();
    // LTP already above T1 (101) → pre-entry TARGET_DONE (hard, not quality)
    const out = await mtfAutoTick(tickP(paper, leanBoard({ ltp: 101.5 })));
    expect(out.opened).toHaveLength(0);
    expect(calls.opened).toHaveLength(0);
    expect(out.skipped.join(' ')).toMatch(/pre-entry recheck blocked/i);
  });

  it('the telemetry surfaces the effective lean lane (never silent)', () => {
    __resetMtfAutoForTests({ config: baseLeanCfg });
    const st = mtfAutoStatus();
    const lane = st.guards.thresholds.leanEntryLane;
    expect(lane.lean).toBe(true);
    expect(lane.leanFloor).toBe(75);
    expect(lane.consensusMode).toBe('shadow');
    expect(lane.mcMode).toBe('shadow');

    __resetMtfAutoForTests({ config: { ...baseLeanCfg, leanEntryLane: false, mcOddsGate: 'enforce' } });
    const st2 = mtfAutoStatus();
    expect(st2.guards.thresholds.leanEntryLane.lean).toBe(false);
    expect(st2.guards.thresholds.leanEntryLane.leanFloor).toBeNull();
    expect(st2.guards.thresholds.leanEntryLane.mcMode).toBe('enforce');
  });
});

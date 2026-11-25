// ============================================================
// test/entryQualityConsensusV21440.test.ts — v21.44.0
// ENTRY QUALITY CONSENSUS: safety hard, quality 2-of-N.
// ------------------------------------------------------------
// The auto lane used to block on any one of seven independent quality
// gates. These tests pin the new contract:
//   • one quality gate = warning, two DISTINCT gates = veto
//   • safety contradictions still block immediately
//   • an extreme pre-entry chase/adverse ratio blocks alone
//   • `single` restores the legacy any-veto-blocks behaviour
// ============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mtf-quality-consensus-'));
process.env.MTF_AUTO_DATA_DIR = TMP_DATA;

vi.mock('../server/mcp/durable.js', () => ({ durablePut: vi.fn() }));

import {
  combineQualityVerdicts,
  groupQualityVetoes,
  normalizeQualityMode,
  isPreEntryHardBlocker,
  isPreEntryQualityBlocker,
  isEntryTimingHardBlocker,
  isLiveQualityHardBlocker,
  preEntryVetoIsForced,
} from '../server/ai/entryQualityConsensus.js';
import {
  mtfAutoTick,
  __resetMtfAutoForTests,
  loadMtfAutoConfig,
  MTF_AUTO_DEFAULTS,
  entryQualityConsensusMode,
  entryQualityConsensusMin,
} from '../server/ai/mtfAutoLink.js';

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

function boardFixture(over: Record<string, unknown> = {}) {
  return {
    ok: true, market: 'CRYPTO', mode: 'INTRADAY', holdMin: 45, minScore: 75,
    rows: [{
      ok: true, symbol: 'BTCUSDT', market: 'CRYPTO', mode: 'INTRADAY', label: '15m → 5m', holdMin: 45,
      superScore: 82, tier: 'STRONG', side: 'LONG', dir: 1, grade: 'A',
      directionVerified: true, directionVerdict: 'VERIFIED',
      triggerFired: true, dualAligned: true, counterTrend: false, tfFit: 'OK',
      autoEligible: true, autoBlockers: [],
      plan: { entry: 100, stopLoss: 99, t1: 101, t2: 102 },
      ...over,
    }],
  };
}

const baseCfg = {
  enabled: true,
  executionMode: 'paper',
  autoStrongOnly: false,
  desks: { india: false, crypto: true },
};

describe('v21.44.0 — quality consensus primitives', () => {
  it('normalizes operator modes without inventing a permissive default', () => {
    expect(normalizeQualityMode('consensus')).toBe('consensus');
    expect(normalizeQualityMode('enforce')).toBe('single');
    expect(normalizeQualityMode('shadow')).toBe('shadow');
    expect(normalizeQualityMode('off')).toBe('off');
    expect(normalizeQualityMode('banana')).toBe('consensus');
  });

  it('one veto warns, two distinct gates block', () => {
    const one = combineQualityVerdicts([{ filter: 'preEntryRecheck', reason: 'late chase 30%' }]);
    expect(one.blocked).toBe(false);
    expect(one.count).toBe(1);
    expect(one.warnings).toHaveLength(1);

    const two = combineQualityVerdicts([
      { filter: 'preEntryRecheck', reason: 'late chase 30%' },
      { filter: 'signalFidelity', reason: 'CHOP regime' },
    ]);
    expect(two.blocked).toBe(true);
    expect(two.count).toBe(2);
    expect(two.summary).toMatch(/preEntryRecheck/);
    expect(two.summary).toMatch(/signalFidelity/);
  });

  it('two reasons from the SAME gate count once (independent agreement only)', () => {
    const grouped = groupQualityVetoes([
      { filter: 'preEntryRecheck', reason: 'late chase 30%' },
      { filter: 'preEntryRecheck', reason: '0.8× ATR adverse' },
    ]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].reasons).toHaveLength(2);
    const verdict = combineQualityVerdicts([
      { filter: 'preEntryRecheck', reason: 'late chase 30%' },
      { filter: 'preEntryRecheck', reason: '0.8× ATR adverse' },
    ]);
    expect(verdict.blocked).toBe(false);
  });

  it('force blocks alone; single restores legacy; shadow/off never block', () => {
    expect(combineQualityVerdicts([{ filter: 'preEntryRecheck', reason: 'extreme', force: true }]).blocked).toBe(true);
    expect(combineQualityVerdicts([{ filter: 'a', reason: 'x' }], { mode: 'single' }).blocked).toBe(true);
    expect(combineQualityVerdicts([{ filter: 'a', reason: 'x' }], { mode: 'shadow' }).blocked).toBe(false);
    expect(combineQualityVerdicts([{ filter: 'a', reason: 'x' }], { mode: 'off' }).blocked).toBe(false);
  });

  it('minVetoes is respected and clamped', () => {
    const three = [
      { filter: 'a', reason: 'x' },
      { filter: 'b', reason: 'y' },
      { filter: 'c', reason: 'z' },
    ];
    expect(combineQualityVerdicts(three, { minVetoes: 3 }).blocked).toBe(true);
    expect(combineQualityVerdicts(three.slice(0, 2), { minVetoes: 3 }).blocked).toBe(false);
    expect(combineQualityVerdicts(three, { minVetoes: 0 }).minVetoes).toBe(2);
    expect(combineQualityVerdicts(three, { minVetoes: 99 }).minVetoes).toBe(5);
  });

  it('classifies structural contradictions as hard and timing as quality', () => {
    expect(isPreEntryHardBlocker('live price already through the stop-loss — signal dead')).toBe(true);
    expect(isPreEntryHardBlocker('target already T1 touched — entry window gone')).toBe(true);
    expect(isPreEntryHardBlocker('signal row 300s old > 120s (stale)')).toBe(true);
    expect(isPreEntryHardBlocker('direction not PAKKA verified (WAIT-LONG)')).toBe(true);
    expect(isPreEntryHardBlocker('liquidity sweep / trap veto active')).toBe(true);
    expect(isPreEntryHardBlocker('late chase: live already 30% of risk past LONG entry')).toBe(false);
    expect(isPreEntryQualityBlocker('late chase: live already 30% of risk past LONG entry')).toBe(true);
    expect(isPreEntryQualityBlocker('reversal: live already 30% of risk against LONG')).toBe(true);
    expect(isPreEntryQualityBlocker('0.80×ATR adverse (weakening)')).toBe(true);
    expect(isPreEntryQualityBlocker('structure break — trigger level lost')).toBe(true);
    expect(isEntryTimingHardBlocker('direction disagreement: row side LONG ≠ execution side SHORT')).toBe(true);
    expect(isEntryTimingHardBlocker('late chase: live already 40% of risk past entry')).toBe(false);
    expect(isLiveQualityHardBlocker('direction not PAKKA verified')).toBe(true);
    expect(isLiveQualityHardBlocker('stop 1.00% = 0.67× ATR < 1.1× floor (noise stop-out)')).toBe(false);
  });

  it('extreme chase/adverse ratios force a solo block', () => {
    expect(preEntryVetoIsForced({ chaseRatio: 0.51 })).toBe(true);
    expect(preEntryVetoIsForced({ chaseRatio: 0.5 })).toBe(false);
    expect(preEntryVetoIsForced({ adverseRatio: 0.41 })).toBe(true);
    expect(preEntryVetoIsForced({ adverseRatio: 0.4 })).toBe(false);
    expect(preEntryVetoIsForced({})).toBe(false);
  });
});

describe('v21.44.0 — config + status contract', () => {
  beforeEach(() => { __resetMtfAutoForTests(); delete process.env.ENTRY_QUALITY_CONSENSUS; delete process.env.ENTRY_QUALITY_CONSENSUS_MIN; });

  it('v21.44.1 — measure-first: defaults to SHADOW/2 (quality evidence logs, never blocks)', () => {
    expect(MTF_AUTO_DEFAULTS.entryQualityConsensus).toBe('shadow');
    expect(MTF_AUTO_DEFAULTS.entryQualityConsensusMin).toBe(2);
    const cfg = loadMtfAutoConfig();
    expect(cfg.entryQualityConsensus).toBe('shadow');
    expect(cfg.entryQualityConsensusMin).toBe(2);
    expect(entryQualityConsensusMode()).toBe('shadow');
    expect(entryQualityConsensusMin()).toBe(2);
  });

  it('an explicit persisted/env value still wins (re-arm recipe)', () => {
    __resetMtfAutoForTests({ config: { entryQualityConsensus: 'consensus' } });
    expect(entryQualityConsensusMode()).toBe('consensus');
  });

  it('persisted single/min-3 survives sanitization; env wins', () => {
    __resetMtfAutoForTests({ config: { entryQualityConsensus: 'single', entryQualityConsensusMin: 3 } });
    expect(entryQualityConsensusMode()).toBe('single');
    expect(entryQualityConsensusMin()).toBe(3);
    process.env.ENTRY_QUALITY_CONSENSUS = 'shadow';
    process.env.ENTRY_QUALITY_CONSENSUS_MIN = '4';
    expect(entryQualityConsensusMode()).toBe('shadow');
    expect(entryQualityConsensusMin()).toBe(4);
  });
});

describe('v21.44.0 — auto tick integration', () => {
  beforeEach(() => { __resetMtfAutoForTests(); delete process.env.ENTRY_QUALITY_CONSENSUS; delete process.env.ENTRY_QUALITY_CONSENSUS_MIN; });

  it('ONE quality veto (late chase) no longer blocks a clean STRONG entry', async () => {
    __resetMtfAutoForTests({ config: baseCfg });
    const { paper, calls } = fakePaper();
    const out = await mtfAutoTick({
      boards: { CRYPTO: boardFixture({ ltp: 100.3 }) },
      paper,
      now: Date.now(),
    });
    expect(out.opened).toHaveLength(1);
    expect(calls.opened).toHaveLength(1);
    expect(out.skipped.join(' ')).not.toMatch(/quality consensus blocked/);
    expect(out.shadow.some((s: any) => s.warnings?.some((w: any) => w.filter === 'preEntryRecheck'))).toBe(true);
  });

  it('v21.44.1 — TWO distinct quality gates do NOT block the default (shadow) config; entry opens with warnings', async () => {
    __resetMtfAutoForTests({ config: baseCfg });
    const { paper, calls } = fakePaper();
    const out = await mtfAutoTick({
      // atr 1.5 vs 1% stop = 0.67× ATR → entry-quality noise stop-out.
      boards: { CRYPTO: boardFixture({ ltp: 100.3, atr: 1.5 }) },
      paper,
      now: Date.now(),
    });
    expect(out.opened).toHaveLength(1);
    expect(calls.opened).toHaveLength(1);
    expect(out.skipped.join(' ')).not.toMatch(/quality consensus blocked/);
    // the measure-first telemetry: both quality filters land as warnings
    const w = out.shadow.flatMap(s => s.warnings || []).map((x: any) => x.filter);
    expect(w).toContain('preEntryRecheck');
    expect(w).toContain('entryQuality');
  });

  it('TWO distinct quality gates (late chase + noise stop) block — explicit consensus config', async () => {
    // v21.44.2: this is the LEGACY (non-lean) consensus contract — the lean
    // lane forces the consensus shadow, so the block only fires on the off-path.
    __resetMtfAutoForTests({ config: { ...baseCfg, entryQualityConsensus: 'consensus', leanEntryLane: false } });
    const { paper, calls } = fakePaper();
    const out = await mtfAutoTick({
      boards: { CRYPTO: boardFixture({ ltp: 100.3, atr: 1.5 }) },
      paper,
      now: Date.now(),
    });
    expect(out.opened).toHaveLength(0);
    expect(calls.opened).toHaveLength(0);
    expect(out.skipped.join(' ')).toMatch(/entry quality consensus blocked \(2\/2\)/);
    expect(out.skipped.join(' ')).toMatch(/preEntryRecheck/);
    expect(out.skipped.join(' ')).toMatch(/entryQuality/);
  });

  it('legacy single mode still blocks the SAME one-veto ticket', async () => {
    // v21.44.2: LEGACY off-path lock — the lean lane (default ON) shadows the
    // consensus, so the single-veto block only fires with lean disabled.
    __resetMtfAutoForTests({ config: { ...baseCfg, entryQualityConsensus: 'single', leanEntryLane: false } });
    const { paper, calls } = fakePaper();
    const out = await mtfAutoTick({
      boards: { CRYPTO: boardFixture({ ltp: 100.3 }) },
      paper,
      now: Date.now(),
    });
    expect(out.opened).toHaveLength(0);
    expect(calls.opened).toHaveLength(0);
    expect(out.skipped.join(' ')).toMatch(/entry quality consensus blocked \(1\/2\)/);
  });

  it('a SAFETY contradiction (price through SL) blocks alone in consensus mode', async () => {
    __resetMtfAutoForTests({ config: baseCfg });
    const { paper, calls } = fakePaper();
    const out = await mtfAutoTick({
      boards: { CRYPTO: boardFixture({ ltp: 98.9 }) },
      paper,
      now: Date.now(),
    });
    expect(out.opened).toHaveLength(0);
    expect(calls.opened).toHaveLength(0);
    expect(out.skipped.join(' ')).toMatch(/pre-entry recheck blocked/);
    expect(out.skipped.join(' ')).toMatch(/through the stop-loss/);
  });
});

describe('v21.44.0 — one timing authority, one decision surface', () => {
  it('the auto lane no longer hard-blocks on the duplicate anti-reversal/anti-chase guards', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../server/ai/mtfAutoLink.js'), 'utf8');
    expect(src).not.toContain('anti-reversal guard blocked entry');
    expect(src).not.toContain('anti-late-chase guard blocked entry');
    expect(src).toContain('combineQualityVerdicts(qualityVetoes');
    expect(src).toContain("addQualityVeto('preEntryRecheck'");
    expect(src).toContain("addQualityVeto('entryQuality'");
  });
});

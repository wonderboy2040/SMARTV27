// ============================================================
// test/optionsAiConfirm.test.ts — v21.43 FreeLLMAPI OPTIONS CONFIRM
// ------------------------------------------------------------
// Locks the contract:
//   1. CONFIRMED  → +3 (scoreCap respected), tier/strongSignal recomputed
//   2. CONFLICT   → −8, strongSignal=false, tradeable=false, aiConflict
//   3. wait / low-confidence → NEUTRAL, score untouched
//   4. model / stale / opposed cards are NEVER sent to the LLM
//   5. memo cache prevents duplicate LLM calls inside the TTL
//   6. router failure → no throw, no fake verdict, card unstamped
// All hermetic — freellmapi is fully mocked, no network.
// ============================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';

const llmMock = vi.hoisted(() => ({
  json: vi.fn(),
  status: vi.fn(),
}));

vi.mock('../server/ai/freellmapi.js', () => ({
  FREELLMAPI_MODELS: { fast: 'auto:fast', smart: 'auto:smart', reliable: 'auto:reliable' },
  freeLlmJson: llmMock.json,
  freeLlmStatus: llmMock.status,
}));

import {
  confirmOptionCards, optionAiConfirmStatus,
  __resetOptionAiConfirmForTests, __setOptionAiConfirmTtlForTests,
  __memoPeekForTests, __testables,
} from '../server/ai/optionsAiConfirm.js';
import { optionTier } from '../server/ai/optionsFlow.js';

function mkCard(overrides: Record<string, any> = {}) {
  return {
    kind: 'option-signal',
    name: 'Nifty50 23Nov 25500 CE',
    symbol: 'NIFTY', type: 'CE', strike: 25500, direction: 'LONG',
    expiry: '2026-11-23', dte: 4,
    entry: 100, target: 130, stopLoss: 75, ltp: 100, lotSize: 75,
    aiScore: 78, tier: 'ACTION', strongSignal: false, signalLabel: 'ACTION CE',
    venue: 'NSE', liveChain: true, chainFresh: true, chainAgeMs: 5_000,
    freshness: 'live', scoreCap: null, tradeable: true,
    chainConfluence: {
      aligned: true, opposed: false, pts: 3, direction: 'BULLISH',
      score: 9, checks: ['PCR 1.48 — put-heavy book'], warnings: [],
    },
    chainContext: {
      spot: 25514.3, pcr: 1.48, maxPain: 25300, atmIV: 13.3, ivPercentile: 40,
      oiLean: -0.2, oiLeanRead: 'PE writing', gammaFlip: 25100, callWall: 25800, putWall: 25200,
    },
    consensus: { side: 'LONG', confidence: 62, grade: 'STRONG', agreement: 0.8 },
    indexLevels: { spot: 25514.3, target1: 25650, stopLoss: 25420 },
    ...overrides,
  };
}

const okStatus = () => ({
  available: true, reachable: true, keyPresent: true, checkedAgeSec: 2,
  modelsCount: 116, lastRoutedVia: 'nvidia/test-model', lastError: null,
});

const verdict = (choice: string, confidence = 0.8) => ({
  json: { choice, confidence, note: `verdict ${choice}`, risk: 'medium' },
  text: '', model: 'test-model', routedVia: 'nvidia/test-model',
  latencyMs: 420, cached: false,
});

beforeEach(() => {
  __resetOptionAiConfirmForTests();
  __setOptionAiConfirmTtlForTests(5 * 60_000);
  llmMock.json.mockReset();
  llmMock.status.mockReset();
  llmMock.status.mockReturnValue(okStatus());
});

describe('optionTier — one shared ladder (85 / 80 / 65)', () => {
  it('maps the exact superIntel thresholds', () => {
    expect(optionTier(85)).toBe('ELITE');
    expect(optionTier(84)).toBe('STRONG');
    expect(optionTier(80)).toBe('STRONG');
    expect(optionTier(79)).toBe('ACTION');
    expect(optionTier(65)).toBe('ACTION');
    expect(optionTier(64)).toBe('WATCH');
    expect(optionTier(null)).toBe('WATCH');
  });
});

describe('confirmOptionCards — FreeLLMAPI second opinion', () => {
  it('CONFIRMED: +3 score, tier upgrade and strongSignal recompute', async () => {
    llmMock.json.mockResolvedValue(verdict('enter_long', 0.82));
    const card = mkCard();
    const sum = await confirmOptionCards([card]);

    expect(llmMock.json).toHaveBeenCalledTimes(1);
    expect(card.aiScore).toBe(81);            // 78 + 3
    expect(card.tier).toBe('STRONG');
    expect(card.strongSignal).toBe(true);     // fresh + STRONG grade + aligned
    expect(card.tradeable).toBe(true);
    expect(card.aiConfirm).toMatchObject({
      provider: 'FreeLLMAPI', verdict: 'CONFIRMED', choice: 'enter_long',
      proposed: 'enter_long', confidence: 0.82,
    });
    expect(sum).toMatchObject({ connected: true, analyzed: 1, confirmed: 1, conflicted: 0 });
  });

  it('CONFIRMED never breaches the freshness scoreCap (recent chain stays below 80)', async () => {
    llmMock.json.mockResolvedValue(verdict('enter_long', 0.9));
    const card = mkCard({
      freshness: 'recent', chainFresh: false, chainAgeMs: 90_000, scoreCap: 79,
      aiScore: 78, tier: 'ACTION',
    });
    await confirmOptionCards([card]);

    expect(card.aiScore).toBe(79);            // 78+3 capped at 79
    expect(card.tier).toBe('ACTION');
    expect(card.strongSignal).toBe(false);    // recent chain can never wear STRONG
  });

  it('CONFLICT: −8, strongSignal=false, tradeable=false, aiConflict=true', async () => {
    llmMock.json.mockResolvedValue(verdict('enter_short', 0.85));
    const card = mkCard({ aiScore: 84, tier: 'STRONG', strongSignal: true });
    const sum = await confirmOptionCards([card]);

    expect(card.aiScore).toBe(76);            // 84 − 8
    expect(card.tier).toBe('ACTION');
    expect(card.strongSignal).toBe(false);
    expect(card.tradeable).toBe(false);
    expect(card.aiConflict).toBe(true);
    expect(card.aiConfirm.verdict).toBe('CONFLICT');
    expect(sum.conflicted).toBe(1);
  });

  it('wait → NEUTRAL stamp only, score/tradeable untouched', async () => {
    llmMock.json.mockResolvedValue(verdict('wait', 0.9));
    const card = mkCard();
    await confirmOptionCards([card]);

    expect(card.aiScore).toBe(78);
    expect(card.tier).toBe('ACTION');
    expect(card.tradeable).toBe(true);
    expect(card.aiConfirm.verdict).toBe('NEUTRAL');
    expect(card.aiConfirm.choice).toBe('wait');
  });

  it('low-confidence agree (<0.55) is an abstain, not a confirmation', async () => {
    llmMock.json.mockResolvedValue(verdict('enter_long', 0.4));
    const card = mkCard();
    await confirmOptionCards([card]);

    expect(card.aiScore).toBe(78);            // no +3
    expect(card.aiConfirm.verdict).toBe('NEUTRAL');
  });

  it('WATCH card gets the analysis stamp but NO score promotion', async () => {
    llmMock.json.mockResolvedValue(verdict('enter_long', 0.9));
    const card = mkCard({ aiScore: 55, tier: 'WATCH', tradeable: false, strongSignal: false });
    const sum = await confirmOptionCards([card]);

    expect(llmMock.json).toHaveBeenCalledTimes(1); // analysis still visible
    expect(card.aiScore).toBe(55);                 // never promoted by AI
    expect(card.tier).toBe('WATCH');
    expect(card.tradeable).toBe(false);
    expect(card.aiConfirm).toMatchObject({ verdict: 'CONFIRMED', applied: false });
    expect(sum.analyzed).toBe(1);
    expect(sum.confirmed).toBe(1);
  });

  it('model / stale / opposed cards are never sent to the LLM', async () => {
    const model = mkCard({ symbol: 'SENSEX', liveChain: false, freshness: 'model', chainFresh: false, source: 'bs-model-sensex-always' });
    const stale = mkCard({ strike: 25600, freshness: 'stale', chainFresh: false, chainAgeMs: 10 * 60_000 });
    const opposed = mkCard({ strike: 25700, chainConfluence: { aligned: false, opposed: true, pts: -3, direction: 'BEARISH', score: -10, checks: [], warnings: [] } });

    const sum = await confirmOptionCards([model, stale, opposed]);

    expect(llmMock.json).not.toHaveBeenCalled();
    expect(sum.analyzed).toBe(0);
    expect(model.aiConfirm).toBeUndefined();
    expect(stale.aiConfirm).toBeUndefined();
    expect(opposed.aiConfirm).toBeUndefined();
  });

  it('memo cache: same contract inside the TTL does not re-call the LLM', async () => {
    llmMock.json.mockResolvedValue(verdict('enter_long', 0.8));
    const a = mkCard();
    await confirmOptionCards([a]);
    expect(llmMock.json).toHaveBeenCalledTimes(1);
    expect(__memoPeekForTests().size).toBe(1);

    const b = mkCard(); // fresh object, same contract key
    await confirmOptionCards([b]);
    expect(llmMock.json).toHaveBeenCalledTimes(1);
    expect(b.aiConfirm.verdict).toBe('CONFIRMED');
  });

  it('router failure → no throw, no fake verdict, card unstamped', async () => {
    llmMock.json.mockRejectedValue(new Error('freellmapi down'));
    const card = mkCard();
    const sum = await confirmOptionCards([card]);

    expect(card.aiConfirm).toBeUndefined();
    expect(card.aiScore).toBe(78);
    expect(sum.pending).toBe(1);
  });

  it('prose-only answer → honest NEUTRAL no-json stamp (no score change)', async () => {
    llmMock.json.mockResolvedValue({ json: null, text: 'I think it will go up', model: 'chatty', latencyMs: 300 });
    const card = mkCard();
    await confirmOptionCards([card]);

    expect(card.aiScore).toBe(78);
    expect(card.aiConfirm.verdict).toBe('NEUTRAL');
    expect(card.aiConfirm.note).toBe('no-json');
  });

  it('prompt carries the live chain analytics for a real analysis', async () => {
    llmMock.json.mockResolvedValue(verdict('enter_long', 0.8));
    await confirmOptionCards([mkCard()]);
    const prompt = llmMock.json.mock.calls[0][0];
    expect(prompt).toContain('PCR 1.48');
    expect(prompt).toContain('max-pain 25300');
    expect(prompt).toContain('gamma flip 25100');
    expect(prompt).toContain('BULLISH');
  });

  it('status exposes connection + model without leaking a key', () => {
    const st = optionAiConfirmStatus();
    expect(st).toMatchObject({ provider: 'FreeLLMAPI', connected: true, keyPresent: true, model: 'auto:smart' });
    expect(JSON.stringify(st)).not.toContain('Bearer');
  });
});

describe('__testables — parser honesty', () => {
  it('accepts only the three contract choices', () => {
    expect(__testables.parseVerdict({ choice: 'enter_long', confidence: 0.8 }, 'enter_long')?.verdict).toBe('CONFIRMED');
    expect(__testables.parseVerdict({ choice: 'enter_short', confidence: 0.8 }, 'enter_long')?.verdict).toBe('CONFLICT');
    expect(__testables.parseVerdict({ choice: 'buy', confidence: 0.9 }, 'enter_long')).toBeNull();
    expect(__testables.parseVerdict(null, 'enter_long')).toBeNull();
  });

  it('isEligible excludes model, stale, untimed and opposed cards', () => {
    expect(__testables.isEligible(mkCard())).toBe(true);
    expect(__testables.isEligible(mkCard({ liveChain: false }))).toBe(false);
    expect(__testables.isEligible(mkCard({ freshness: 'stale' }))).toBe(false);
    expect(__testables.isEligible(mkCard({ freshness: 'live-untimed' }))).toBe(false);
    expect(__testables.isEligible(mkCard({ chainConfluence: { opposed: true } }))).toBe(false);
    expect(__testables.isEligible(mkCard({ tradeable: false, aiScore: 40 }))).toBe(true); // analysis-only
  });
});

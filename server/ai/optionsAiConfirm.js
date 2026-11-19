// ============================================================
// server/ai/optionsAiConfirm.js — v21.43 OPTIONS AI CONFIRM LAYER
// ------------------------------------------------------------
// FreeLLMAPI (local router, default 127.0.0.1:31415) ka strict-JSON
// second opinion har ELIGIBLE live-chain option card ke liye.
//
//   Quant computes, AI confirms — AI kabhi side/size/SL/target nahi
//   badalta. Sirf entry-timing verdict + score ± deta hai:
//
//   CONFIRMED  choice == proposed (CE→enter_long, PE→enter_short)
//              aiScore +3 (scoreCap ke andar), tier/strongSignal recompute
//   CONFLICT   LLM ne ULTA side chuna
//              aiScore −8, strongSignal=false, tradeable=false, aiConflict
//   NEUTRAL    wait / low-confidence / no-JSON / router down
//              sirf stamp — score untouched (honest abstain)
//
// Only live chains (fresh/recent, not opposed) are sent: model chains
// have no OI/PCR and can never wear the strong badge anyway. Every such
// card gets the analysis stamp; score/tradeable effects apply ONLY to
// already-actionable cards (tradeable or AI ≥65) — AI can confirm a
// setup, never promote a WATCH card into a trade.
//
// COST/LATENCY: 5-min memo per contract (symbol|expiry|type|strike|side)
// + 2×TTL stale-while-revalidate + single-flight + 5s soft deadline.
// The 20s view refresh never blocks on the LLM; unresolved cards stamp
// on the next cycle (board confirm layer ka proven pattern).
// Env: OPTION_AI_CONFIRM=off disables · OPTION_AI_CONFIRM_TTL_MS tunes memo.
// ============================================================
import { freeLlmJson, freeLlmStatus, FREELLMAPI_MODELS } from './freellmapi.js';
import { optionTier } from './optionsFlow.js';

const MODE = String(process.env.OPTION_AI_CONFIRM ?? 'auto').toLowerCase(); // 'off' | 'auto'
const MODEL = FREELLMAPI_MODELS.smart;
const DEADLINE_MS = 5_000;
const MAX_CARDS = 6;
const CONFIRM_MIN_CONF = 0.55;   // below this an "enter" is an abstain
const CONFLICT_MIN_CONF = 0.60;  // only a confident opposite side may demote
const NO_JSON_TTL_MS = 60_000;   // don't hammer a prose-only model every cycle
let MEMO_TTL_MS = (() => {
  const n = Number(process.env.OPTION_AI_CONFIRM_TTL_MS);
  return Number.isFinite(n) ? Math.max(30_000, Math.min(30 * 60_000, Math.round(n))) : 5 * 60_000;
})();
const staleMaxMs = () => Math.max(2 * MEMO_TTL_MS, MEMO_TTL_MS + 1_000);
const SWRV = String(process.env.OPTION_AI_CONFIRM_SWRV ?? '1') !== '0';

const _memo = new Map();     // key -> { at, ttlMs, verdict }
const _inflight = new Map(); // key -> Promise<verdict>

const SYSTEM = `You are the final FreeLLMAPI confirmation layer for an Indian index OPTIONS premium trade (NSE/BSE, INR).
Judge ONLY whether to take THIS contract now. You cannot change side, size, stop-loss or target.
A CE is a BUY-PREMIUM bullish trade; a PE is a BUY-PREMIUM bearish trade.
Rules:
- Chain read against the card, stale/model chain, weak consensus, poor reward:risk, or contradictory OI/PCR = wait.
- Aligned fresh chain + sane stop + non-counter-trend + acceptable premium = take.
- If the deterministic card status is WATCH, prefer wait unless the chain/consensus clearly justify an early entry.
- Never invent data. If a field is missing, say wait rather than guess.
- Prefer wait when your confidence is below 0.55.
- note must be YOUR OWN concise reason (<=90 chars), not a restatement of the input lines.
OUTPUT STRICT JSON ONLY (no markdown, no prose, no fences):
{"choice":"enter_long"|"enter_short"|"wait","confidence":0.0-1.0,"note":"<=90 chars Hinglish reason","risk":"low"|"medium"|"high"}
choice semantics: enter_long = BUY this CE, enter_short = BUY this PE, wait = stand aside.`;

/** ~0.25% bucket — keeps repeated prompts identical while the premium
 *  breathes, so FreeLLMAPI's JSON cache actually hits. */
function bucketPrice(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 'n/a';
  const q = n * 0.0025;
  const b = Math.round(n / q) * q;
  return b >= 100 ? b.toFixed(1) : b >= 1 ? b.toFixed(2) : b.toFixed(4);
}

function keyOf(card) {
  return [
    card?.symbol || '?',
    card?.expiry || '?',
    card?.type || '?',
    Math.round(Number(card?.strike) || 0),
    card?.direction || '?',
    String(card?.consensus?.grade || '?').toUpperCase(),
    card?.chainConfluence?.direction || '?',
  ].join('|');
}

/** Live, non-opposed cards with a directional side — analysis ke liye
 *  eligible. Score effects sirf ACTIONABLE cards pe lagte hain (neeche). */
function isEligible(card) {
  if (!card) return false;
  if (card.direction !== 'LONG' && card.direction !== 'SHORT') return false;
  if (card.liveChain !== true) return false;
  if (card.freshness !== 'live' && card.freshness !== 'recent') return false;
  if (card.chainConfluence?.opposed) return false;
  return true;
}

function promptFor(card) {
  const ctx = card.chainContext || {};
  const conf = card.chainConfluence || {};
  const lines = [
    'Desk: India index options — BUY PREMIUM only (NSE/BSE, INR).',
    `Underlying: ${card.symbol} (${card.venue || (card.symbol === 'SENSEX' ? 'BSE' : 'NSE')}), spot ${bucketPrice(ctx.spot ?? card.indexLevels?.spot)}`,
    `Contract: ${card.name} — ${card.type === 'CE' ? 'CALL (CE, profits when underlying rises)' : 'PUT (PE, profits when underlying falls)'}`,
    `Consensus side: ${card.direction} (${card.type}) · confidence ${card.consensus?.confidence ?? 'n/a'}% · grade ${card.consensus?.grade ?? 'n/a'}`,
    `Card AI: ${card.aiScore}/100 ${card.tier} · POP ${card.pop ?? 'n/a'}% · R:R ${card.rr ?? 'n/a'}R · delta ${card.delta ?? 'n/a'}`,
    `Deterministic status: ${card.tradeable ? 'TRADEABLE' : 'WATCH (not tradeable yet)'} · strongSignal ${card.strongSignal ? 'YES' : 'no'}`,
    `Premium plan: entry ${bucketPrice(card.entry)}, target ${bucketPrice(card.target)}, stop ${bucketPrice(card.stopLoss)} · lot ${card.lotSize ?? 'n/a'}`,
    `Expiry: ${card.expiry} (DTE ${card.dte ?? 'n/a'})`,
    `Live chain: ${card.venue || 'exchange'} ${card.freshness}, age ${Math.round((Number(card.chainAgeMs) || 0) / 1000)}s`,
  ];
  if (ctx.pcr != null || ctx.maxPain != null) {
    lines.push(`Chain analytics: PCR ${ctx.pcr ?? 'n/a'} · max-pain ${ctx.maxPain ?? 'n/a'} · ATM IV ${ctx.atmIV ?? 'n/a'} · IV percentile ${ctx.ivPercentile ?? 'n/a'} · OI lean ${ctx.oiLean ?? 'n/a'}${ctx.oiLeanRead ? ` (${ctx.oiLeanRead})` : ''}`);
    lines.push(`GEX: gamma flip ${ctx.gammaFlip ?? 'n/a'} · call wall ${ctx.callWall ?? 'n/a'} · put wall ${ctx.putWall ?? 'n/a'}`);
  }
  if (conf.direction) {
    lines.push(`Chain read: ${conf.direction} (${conf.pts > 0 ? '+' : ''}${conf.pts ?? 0} pts, confluence ${conf.score > 0 ? '+' : ''}${conf.score ?? 0}) — ${conf.aligned ? 'ALIGNED with this card' : conf.opposed ? 'AGAINST this card' : 'neutral'}`);
  }
  if (card.indexLevels?.target1 != null) {
    lines.push(`Index plan: spot ${bucketPrice(card.indexLevels.spot)}, target ${bucketPrice(card.indexLevels.target1)}, stop ${bucketPrice(card.indexLevels.stopLoss)}`);
  }
  lines.push('', '--- Decision criteria ---');
  lines.push(`enter_long: BUY this ${card.type} now (CE) — chain + consensus + premium setup justify entry`);
  lines.push(`enter_short: BUY this ${card.type} now (PE) — chain + consensus + premium setup justify entry`);
  lines.push('wait: stand aside — conditions do not justify this premium entry');
  return lines.join('\n');
}

function parseVerdict(json, proposed) {
  if (!json || typeof json !== 'object') return null;
  const choice = String(json.choice || '').toLowerCase();
  if (!['enter_long', 'enter_short', 'wait'].includes(choice)) return null;
  const c = Number(json.confidence);
  const confidence = Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : null;
  const note = typeof json.note === 'string' ? json.note.slice(0, 140) : null;
  const riskRaw = String(json.risk || '').toLowerCase();
  const risk = ['low', 'medium', 'high'].includes(riskRaw) ? riskRaw : null;
  // A weak "enter" or a weak opposite call is an abstain, not a verdict.
  let verdict = 'NEUTRAL';
  if (choice === proposed && (confidence == null || confidence >= CONFIRM_MIN_CONF)) verdict = 'CONFIRMED';
  else if (choice !== 'wait' && choice !== proposed && (confidence == null || confidence >= CONFLICT_MIN_CONF)) verdict = 'CONFLICT';
  return { choice, verdict, confidence, note, risk };
}

async function runOne(card) {
  const proposed = card.direction === 'LONG' ? 'enter_long' : 'enter_short';
  const t0 = Date.now();
  const out = await freeLlmJson(promptFor(card), {
    system: SYSTEM,
    model: MODEL,
    temperature: 0.1,
    maxTokens: 260,
    timeoutMs: 12_000,
  });
  const parsed = parseVerdict(out?.json, proposed);
  if (!parsed) {
    return {
      verdict: 'NEUTRAL', choice: null, proposed, confidence: null,
      note: 'no-json', reason: 'no-json', risk: null,
      model: out?.model || MODEL, routedVia: out?.routedVia || null,
      latencyMs: out?.latencyMs ?? (Date.now() - t0), cached: out?.cached === true,
      at: Date.now(),
    };
  }
  return {
    ...parsed,
    proposed,
    model: out?.model || MODEL,
    routedVia: out?.routedVia || null,
    latencyMs: out?.latencyMs ?? (Date.now() - t0),
    cached: out?.cached === true,
    at: Date.now(),
  };
}

function wire(card, key) {
  if (_inflight.has(key)) return _inflight.get(key);
  const p = runOne(card)
    .then((verdict) => {
      const ttl = verdict.reason === 'no-json' ? NO_JSON_TTL_MS : MEMO_TTL_MS;
      _memo.set(key, { at: Date.now(), ttlMs: ttl, verdict });
      return verdict;
    })
    .finally(() => { _inflight.delete(key); });
  _inflight.set(key, p);
  // bounded memo — long sessions never grow this without limit
  if (_memo.size > 300) {
    const it = _memo.keys();
    for (let i = 0; i < 60; i++) {
      const k = it.next().value;
      if (k === undefined) break;
      _memo.delete(k);
    }
  }
  return p;
}

function recompute(card, conflict) {
  const grade = String(card.consensus?.grade || '').toUpperCase();
  const gradeTradeable = grade === 'ELITE' || grade === 'STRONG' || grade === 'ACTION';
  card.tier = optionTier(card.aiScore);
  card.signalLabel = `${card.tier} ${card.type}`;
  card.strongSignal = Boolean(
    card.chainFresh
    && gradeTradeable
    && !card.chainConfluence?.opposed
    && (card.tier === 'ELITE' || card.tier === 'STRONG'),
  );
  card.tradeable = conflict ? false : (gradeTradeable || Number(card.aiScore) >= 75);
}

function applyVerdict(card, v, actionable) {
  const stamp = {
    provider: 'FreeLLMAPI',
    verdict: v.verdict,
    choice: v.choice ?? null,
    proposed: v.proposed ?? null,
    confidence: v.confidence ?? null,
    note: v.note ?? null,
    risk: v.risk ?? null,
    reason: v.reason ?? null,
    model: v.model ?? null,
    routedVia: v.routedVia ?? null,
    latencyMs: v.latencyMs ?? null,
    cached: v.cached === true,
    stale: v.stale === true,
    applied: actionable === true,
    at: v.at ?? Date.now(),
  };
  card.aiConfirm = stamp;
  if (!actionable) {
    // WATCH cards get the analysis text but NEVER a score promotion.
    if (v.verdict === 'CONFLICT') card.aiConflict = true;
    return;
  }
  if (v.verdict === 'CONFIRMED') {
    const cap = card.scoreCap == null ? 100 : Number(card.scoreCap);
    card.aiScore = Math.min(cap, Math.round((Number(card.aiScore) || 0) + 3));
    card.aiConflict = false;
  } else if (v.verdict === 'CONFLICT') {
    card.aiConflict = true;
    card.aiScore = Math.max(0, Math.round((Number(card.aiScore) || 0) - 8));
  }
  recompute(card, v.verdict === 'CONFLICT');
}

/** Health/status block for the options view + UI chip. */
export function optionAiConfirmStatus() {
  const st = freeLlmStatus();
  return {
    provider: 'FreeLLMAPI',
    enabled: MODE !== 'off',
    connected: st.available === true,
    reachable: st.reachable === true,
    keyPresent: st.keyPresent === true,
    model: MODEL,
    modelsCount: st.modelsCount ?? null,
    lastRoutedVia: st.lastRoutedVia ?? null,
    lastError: st.lastError ?? null,
    ttlMs: MEMO_TTL_MS,
    deadlineMs: DEADLINE_MS,
    memoSize: _memo.size,
  };
}

/**
 * Confirm the eligible cards with FreeLLMAPI. MUTATES cards: aiConfirm,
 * aiScore, tier, strongSignal, tradeable. Never throws.
 * @param {Array} cards
 * @param {{deadlineMs?:number}} [opts]
 * @returns {Promise<object>} summary for the view
 */
export async function confirmOptionCards(cards, opts = {}) {
  const summary = {
    provider: 'FreeLLMAPI', enabled: MODE !== 'off',
    connected: freeLlmStatus().available === true,
    analyzed: 0, confirmed: 0, conflicted: 0, neutral: 0, pending: 0,
    model: MODEL, reason: null,
  };
  if (MODE === 'off' || !Array.isArray(cards) || cards.length === 0) return summary;
  const st = freeLlmStatus();
  // Probed-and-down: stay honest without hammering the router every cycle.
  if (!st.available && st.checkedAgeSec != null && st.reachable === false) {
    summary.reason = st.lastError || 'freellmapi-unavailable';
    return summary;
  }
  const eligible = cards.filter(isEligible).slice(0, MAX_CARDS);
  if (eligible.length === 0) return summary;

  const jobs = eligible.map((card) => {
    const key = keyOf(card);
    const hit = _memo.get(key);
    const ttl = hit?.ttlMs ?? MEMO_TTL_MS;
    if (hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.verdict);
    if (hit?.verdict && SWRV && Date.now() - hit.at < staleMaxMs()) {
      // Serve the recent verdict instantly; refresh in the background.
      wire(card, key).catch(() => {});
      return Promise.resolve({ ...hit.verdict, stale: true });
    }
    return wire(card, key);
  });

  await Promise.race([
    Promise.allSettled(jobs),
    new Promise((res) => {
      const t = setTimeout(res, Math.max(500, Number(opts?.deadlineMs) || DEADLINE_MS));
      if (t.unref) t.unref();
    }),
  ]);

  for (const card of eligible) {
    const hit = _memo.get(keyOf(card));
    if (!hit?.verdict) { summary.pending++; continue; }
    const actionable = card.tradeable === true || Number(card.aiScore) >= 65;
    applyVerdict(card, hit.verdict, actionable);
    summary.analyzed++;
    if (hit.verdict.verdict === 'CONFIRMED') summary.confirmed++;
    else if (hit.verdict.verdict === 'CONFLICT') summary.conflicted++;
    else summary.neutral++;
  }
  // The router may have been unprobed at entry and probed successfully by
  // the calls above — report the FINAL state, not the cold-start state.
  const final = freeLlmStatus();
  summary.connected = final.available === true;
  if (!summary.connected && !summary.reason) summary.reason = final.lastError || null;
  return summary;
}

// ---------------- test hooks ----------------
export function __resetOptionAiConfirmForTests() {
  _memo.clear();
  _inflight.clear();
  MEMO_TTL_MS = 5 * 60_000;
}
export function __setOptionAiConfirmTtlForTests(ms) {
  const n = Number(ms);
  if (Number.isFinite(n) && n >= 0) MEMO_TTL_MS = n;
}
export function __memoPeekForTests() { return _memo; }
export const __testables = { bucketPrice, keyOf, isEligible, parseVerdict, promptFor };

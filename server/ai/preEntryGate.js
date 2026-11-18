// ============================================================
// server/ai/preEntryGate.js — v21.38.0 PRE-ENTRY RECHECK GATE
// ------------------------------------------------------------
// WHY THIS EXISTS (measured, not assumed):
//   • 30 of 49 closed MTF paper trades lost; 13 never worked at all
//     (MFE < 0.1R) — they were entered into an already-fading move.
//   • 8 losers had already shown >= 0.3R MFE and gave it back because
//     nothing protected the position between entry and TP1.
//   • the paper lane bypassed the live-only fidelity / entry-quality
//     gates: BNB paper opened seconds AFTER the live lane had blocked
//     the exact same setup.
//   • MTF watch rows shipped `atr: null`, so the recheck drifted to a
//     hard-coded 1.2% ATR and WEAKENING fired far too late.
//
// This module is the SINGLE pure entry-decision surface shared by:
//   • the auto lane (mtfAutoLink.mtfAutoTick)
//   • the manual PAPER route (/api/ai/mtf-dual/paper)
//   • the manual LIVE route  (/api/ai/mtf-dual/live)
//   • the realtime recheck telemetry (signalRecheck)
//
// It is deliberately dependency-light (superIntel + directionCertificate
// only) so it can never create an import cycle with signalRecheck /
// mtfAutoLink. Missing evidence fails OPEN (no fabricated blocks); every
// block is a concrete, numeric contradiction.
// ============================================================
import { liveInvalidationCheck } from './superIntel.js';
import { normalizeSide } from './directionCertificate.js';

export const PRE_ENTRY_DEFAULTS = Object.freeze({
  /** Board rows rebuild every ~2s; 2 min is already a stale thesis. */
  maxRowAgeMs: 120_000,
  /** Live already >25% of the risk PAST entry = late chase. */
  maxChaseRiskRatio: 0.25,
  /** Live already >20% of the risk TOWARD the stop = reversal. */
  maxAdverseRiskRatio: 0.20,
  /** Soft caution at 0.5×ATR adverse (telemetry, never blocks). */
  cautionAdverseAtrX: 0.5,
  /** Hard weakening at 0.75×ATR adverse (same rule as the recheck loop). */
  blockAdverseAtrX: 0.75,
  /** A T1 closer than this many R at entry is a poor reward/risk ticket. */
  minT1RemainR: 0.35,
  /** v21.41.0: a quote older than this cannot be trusted for an entry. */
  maxQuoteAgeMs: 5_000,
});

const _num = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

const _STATE_RANK = {
  OK: 9,
  CAUTION: 8,
  LATE_CHASE: 7,
  WEAKENING: 6,
  STRUCTURE_BREAK: 5,
  VETO: 4,
  REVERSAL: 3,
  TARGET_DONE: 2,
  INVALIDATED: 1,
  STALE: 0,
  NO_PRICE: 0,
  NO_PLAN: 0,
};

/**
 * The MEASURED ATR only — absolute ATR first, then a real ATR% converted to
 * price. Never synthesises a value from the stop distance or a 1.2% default.
 * The stop-floor gate must share this exact number with preEntryRecheck so
 * the same ticket is never judged against two different volatility reads.
 */
export function measuredRowAtr(row = {}) {
  const entry = _num(row?.entry ?? row?.plan?.entry);
  const explicit = _num(row?.atr) ?? _num(row?.plan?.atrUsed) ?? _num(row?.context?.atr);
  if (explicit != null && explicit > 0) return explicit;
  const atrPct = _num(row?.atrPct) ?? _num(row?.context?.atrPct);
  if (entry != null && entry > 0 && atrPct != null && atrPct > 0) {
    return +(entry * atrPct / 100).toFixed(8);
  }
  return null;
}

/**
 * Resolve the REAL ATR for a row instead of the old unconditional
 * `entry × 1.2%` fallback.
 *
 * Priority:
 *   1. explicit `row.atr` / `row.plan.atrUsed` (absolute price distance)
 *   2. `row.atrPct` / `row.context.atrPct` (percent of entry — what the
 *      MTF dual board already computes: tradePlanner `context.atrPct`)
 *   3. plan risk ÷ mode ATR multiplier (the planner sets SL at
 *      `atrSlMult × ATR`, so this is an exact inverse)
 *   4. legacy 1.2% last resort (kept for old callers/tests ONLY)
 *
 * @returns {number|null} absolute ATR in price units
 */
export function resolveRowAtr(row = {}) {
  const measured = measuredRowAtr(row);
  if (measured != null) return measured;
  const entry = _num(row?.entry ?? row?.plan?.entry);
  const sl = _num(row?.stopLoss ?? row?.plan?.stopLoss);
  if (entry != null && entry > 0 && sl != null && sl > 0) {
    const risk = Math.abs(entry - sl);
    const m = _num(row?.atrSlMult) ?? _num(row?.plan?.atrSlMult);
    const mult = m != null && m > 0 ? m : 1.4;
    if (risk > 0) return +(risk / mult).toFixed(8);
  }
  return entry != null && entry > 0 ? +(entry * 0.012).toFixed(8) : null;
}

function _rowAgeMs(row, now, explicit) {
  const direct = _num(explicit);
  if (direct != null && direct >= 0) return direct;
  const built = _num(row?.builtAt) ?? _num(row?.asOf) ?? _num(row?.boardAt) ?? _num(row?.generatedAt);
  if (built != null && built > 0) return Math.max(0, now - built);
  return null;
}

function _sideStable(row) {
  const v = row?.sideStable
    ?? row?.barConfirmation?.sideStable
    ?? row?.signalStability?.sideStable;
  return v === false ? false : (v === true ? true : null);
}

/**
 * The ONE pre-entry verdict. Pure; never throws.
 *
 * @param {object}   p
 * @param {object}   p.row          board/MTF row
 * @param {string}   p.side         execution side (defaults to row.side)
 * @param {number}   p.livePrice    the freshest quote available
 * @param {number}   p.now
 * @param {number}   [p.rowAgeMs]   explicit row age (otherwise builtAt/asOf)
 * @param {boolean}  [p.requireVerified]  hard-require directionVerified===true
 * @param {boolean}  [p.requireDeepAligned] block deep side opposite (default true)
 * @param {number}   [p.quoteAgeMs]  liveFeed ingest age of the quote, when known
 * @param {string}   [p.quoteSource] feed that produced the quote (telemetry)
 * @param {object}   [p.thresholds] override PRE_ENTRY_DEFAULTS
 *
 * @returns {{
 *   ok: boolean, side: 'LONG'|'SHORT'|null, state: string,
 *   blockers: string[], warnings: string[],
 *   metrics: object, thresholds: object
 * }}
 */
export function preEntryRecheck({
  row = {},
  side = null,
  livePrice = null,
  now = Date.now(),
  rowAgeMs = null,
  requireVerified = false,
  requireDeepAligned = true,
  quoteAgeMs = null,
  quoteSource = null,
  thresholds = {},
} = {}) {
  const t = { ...PRE_ENTRY_DEFAULTS, ...(thresholds && typeof thresholds === 'object' ? thresholds : {}) };
  const blockers = [];
  const warnings = [];
  const note = [];
  const add = (list, msg) => { if (msg && !list.includes(msg)) list.push(msg); };
  const block = (msg, state) => { add(blockers, msg); note.push(state); };
  const warn = (msg) => add(warnings, msg);

  const s = normalizeSide(side ?? row?.side);
  const rowSide = normalizeSide(row?.side);
  const px = _num(livePrice);
  const entry = _num(row?.plan?.entry ?? row?.entry);
  const sl = _num(row?.plan?.stopLoss ?? row?.stopLoss);
  const t1 = _num(row?.plan?.t1 ?? row?.target1);
  const t2 = _num(row?.plan?.t2 ?? row?.target2);
  const risk = entry != null && sl != null && entry > 0 && sl > 0 ? Math.abs(entry - sl) : null;
  const atr = resolveRowAtr({ ...row, entry, stopLoss: sl });
  const age = _rowAgeMs(row, now, rowAgeMs);

  // ---- structural contradictions -------------------------------------
  if (!row || typeof row !== 'object') {
    block('signal row unavailable', 'NO_PLAN');
  } else if (row.ok === false) {
    block(`plan unavailable${row.error ? ` — ${row.error}` : ''}`, 'NO_PLAN');
  }
  if (!(entry > 0) || !(sl > 0)) block('incomplete entry/stop ticket', 'NO_PLAN');
  if (!s) block('direction unresolved — LONG/SHORT required', 'NO_PLAN');
  // A missing quote is missing EVIDENCE, not a contradiction — the legacy
  // quote-domain gate in mtfAutoLink still blocks a symbol that HAS a feed but
  // no print. Here we only lose the timing/ATR checks, so warn (fail-open).
  if (!(px > 0)) warn('live price unavailable — entry-timing checks skipped (fail-open)');
  if (rowSide && s && rowSide !== s) {
    block(`direction disagreement: row ${rowSide} ≠ execution ${s}`, 'VETO');
  }

  // ---- MTF ↔ DEEP combined verdict (super-intelligence gate) ----------
  const fv = row?.finalVerdict && typeof row.finalVerdict === 'object' ? row.finalVerdict : null;
  const decision = String(fv?.decision || '').toUpperCase();
  const deepSide = normalizeSide(fv?.deep?.side);
  if (decision === 'HOLD' || decision === 'STAND_ASIDE') {
    block(`MTF↔DEEP combined verdict ${decision} — entry hold`, 'VETO');
  }
  if (String(fv?.alignment || '').toUpperCase() === 'CONFLICT') {
    block(`MTF↔DEEP engine conflict (${fv?.mtf?.side || rowSide || '—'} vs ${fv?.deep?.side || '—'})`, 'VETO');
  }
  if (requireDeepAligned && deepSide && s && deepSide !== s) {
    block(`deep ensemble ${deepSide} vs execution ${s} — opposite lane`, 'VETO');
  }

  // ---- hard veto flags already stamped on the row ---------------------
  if (row?.trapVeto === true) block('liquidity sweep / trap veto active', 'VETO');
  if (row?.zoneWallVeto === true) block('fresh supply/demand zone wall veto', 'VETO');
  if (row?.reversalRisk === true) block('action-TF reversal / exhaustion risk', 'VETO');
  if (row?.trigger?.opposingFlow === true) block('action-TF opposing flow', 'VETO');
  if (row?.trigger?.postPeakTrap === true) block('post-peak late-entry trap', 'VETO');
  if (row?.trigger?.overextended === true) block('entry overextended / chase risk', 'VETO');
  if (_sideStable(row) === false) {
    block('closed-bar reversal: last closed bar side differs from the live side', 'VETO');
  }
  if (requireVerified && row?.directionVerified !== true) {
    block(`direction not PAKKA verified (${row?.directionVerdict || 'pending'})`, 'VETO');
  }

  // ---- staleness ------------------------------------------------------
  if (age != null && age > t.maxRowAgeMs) {
    block(`signal row ${Math.round(age / 1000)}s old > ${Math.round(t.maxRowAgeMs / 1000)}s (stale)`, 'STALE');
  }
  // v21.41.0 [QUOTE FRESHNESS]: the board row can be fresh while the quote
  // it is priced against is minutes old (stale WS / dead REST leg). Only
  // block when the age is KNOWN — a missing tick is missing evidence.
  const qAge = _num(quoteAgeMs);
  const maxQAge = _num(t.maxQuoteAgeMs);
  if (qAge != null && qAge >= 0 && maxQAge != null && maxQAge > 0 && qAge > maxQAge) {
    block(
      `live quote ${(qAge / 1000).toFixed(1)}s old > ${(maxQAge / 1000).toFixed(1)}s (${quoteSource || 'feed'} stale)`,
      'STALE',
    );
  }

  // ---- price already through the plan --------------------------------
  if (s && px > 0) {
    const inv = liveInvalidationCheck({
      side: s, liveLtp: px, stopLoss: sl,
      entryZoneLow: null, entryZoneHigh: null, atr,
    });
    if (inv?.status === 'invalidated') {
      block('live price already through the stop-loss — signal dead', 'INVALIDATED');
    }
    const t1Hit = t1 != null && t1 > 0 && (s === 'LONG' ? px >= t1 : px <= t1);
    const t2Hit = t2 != null && t2 > 0 && (s === 'LONG' ? px >= t2 : px <= t2);
    if (t2Hit || t1Hit) {
      block(
        `target already ${t2Hit ? 'T2' : 'T1'} touched — entry window gone (${s === 'LONG' ? 'price above' : 'price below'} target)`,
        'TARGET_DONE',
      );
    }
  }

  // ---- risk-normalised timing ----------------------------------------
  const isLong = s === 'LONG';
  let chaseRatio = null;
  let adverseRatio = null;
  let t1RemainR = null;
  if (s && px > 0 && entry > 0 && risk != null && risk > 0) {
    const favorable = isLong ? px - entry : entry - px;
    chaseRatio = favorable / risk;
    adverseRatio = -favorable / risk;
    if (chaseRatio > t.maxChaseRiskRatio) {
      block(
        `late chase: live already ${(chaseRatio * 100).toFixed(0)}% of risk past ${s} entry (max ${(t.maxChaseRiskRatio * 100).toFixed(0)}%)`,
        'LATE_CHASE',
      );
    }
    if (adverseRatio > t.maxAdverseRiskRatio) {
      block(
        `reversal: live already ${(adverseRatio * 100).toFixed(0)}% of risk against ${s} (max ${(t.maxAdverseRiskRatio * 100).toFixed(0)}%)`,
        'REVERSAL',
      );
    }
    if (t1 != null && t1 > 0) {
      t1RemainR = (isLong ? t1 - px : px - t1) / risk;
      if (t1RemainR < t.minT1RemainR) {
        warn(`T1 sirf ${Math.max(0, t1RemainR).toFixed(2)}R door — reward/risk patla`);
      }
    }
  }

  // ---- structure break + ATR adverse state ---------------------------
  const triggerLevel = _num(row?.triggerLevel ?? row?.plan?.triggerLevel);
  if (s && px > 0 && triggerLevel != null && triggerLevel > 0 && atr != null && atr > 0
    && row?.triggerFired === true) {
    const buffer = atr * 0.05;
    const broke = isLong ? px < triggerLevel - buffer : px > triggerLevel + buffer;
    if (broke) {
      block(
        `structure break: live ${px} lost trigger level ${triggerLevel} (${isLong ? 'below' : 'above'})`,
        'STRUCTURE_BREAK',
      );
    }
  }
  if (s && px > 0 && entry > 0 && atr != null && atr > 0) {
    const adverseAbs = isLong ? entry - px : px - entry;
    if (adverseAbs > t.blockAdverseAtrX * atr) {
      block(
        `price ${(adverseAbs / atr).toFixed(2)}×ATR against ${s} — thesis already under water`,
        'WEAKENING',
      );
    } else if (adverseAbs > t.cautionAdverseAtrX * atr) {
      warn(`price ${(adverseAbs / atr).toFixed(2)}×ATR against ${s} — momentum fading`);
    }
  }

  const state = note.length
    ? note.reduce((worst, cur) => ((_STATE_RANK[cur] ?? 5) < (_STATE_RANK[worst] ?? 5) ? cur : worst), note[0])
    : (warnings.length ? 'CAUTION' : 'OK');

  return {
    ok: blockers.length === 0,
    side: s,
    state,
    blockers,
    warnings,
    metrics: {
      livePrice: px,
      entry,
      stopLoss: sl,
      target1: t1,
      target2: t2,
      risk,
      atr,
      atrPct: entry > 0 && atr != null ? +(atr / entry * 100).toFixed(3) : null,
      rowAgeMs: age,
      quoteAgeMs: qAge,
      quoteSource: quoteSource || null,
      chaseRatio: chaseRatio == null ? null : Math.round(chaseRatio * 1000) / 1000,
      adverseRatio: adverseRatio == null ? null : Math.round(adverseRatio * 1000) / 1000,
      t1RemainR: t1RemainR == null ? null : Math.round(t1RemainR * 1000) / 1000,
      triggerLevel,
      finalDecision: decision || null,
      deepSide: deepSide || null,
      directionVerified: row?.directionVerified === true,
      sideStable: _sideStable(row),
    },
    thresholds: t,
  };
}

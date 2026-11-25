// ============================================================
// server/ai/entryQualityConsensus.js — v21.44.0 ENTRY QUALITY CONSENSUS
// ------------------------------------------------------------
// WHY THIS EXISTS:
//   The auto lane grew seven independent pre-entry quality vetoes
//   (entry timing, pre-entry recheck timing, signal fidelity, MC odds,
//   breakout confirm, late wave, live entry quality). Each one was added
//   for a measured failure mode, but every one could veto a setup on its
//   own. The result was the operator-visible paradox: the board shows a
//   STRONG/ELITE signal, the direction is right, yet no trade ever opens
//   because one gate disagrees while the others pass.
//
// THE CONTRACT:
//   • SAFETY blockers (direction, stale plan/quote, SL already through,
//     target already done, trap/zone/reversal flags, deep conflict,
//     risk/loss locks) are NEVER part of this layer — they stay hard.
//   • QUALITY blockers are collected as `{ filter, reason, force? }`.
//     In `consensus` mode (default) a single quality gate is a WARNING;
//     two or more DISTINCT gates must agree before the entry is blocked.
//     `single` restores the legacy any-veto-blocks behaviour.
//   • `force: true` is reserved for an extreme, numeric contradiction
//     (e.g. price already >50% of risk past entry) and blocks alone.
//   • `shadow`/`off` never block — telemetry only.
//
// This module is pure and dependency-free so both the auto tick and
// tests can use the exact same decision surface.
// ============================================================

export const QUALITY_CONSENSUS_DEFAULTS = Object.freeze({
  mode: 'consensus',
  minVetoes: 2,
  maxVetoes: 5,
});

const _MODE_ALIASES = new Map([
  ['off', 'off'],
  ['0', 'off'],
  ['false', 'off'],
  ['disabled', 'off'],
  ['shadow', 'shadow'],
  ['observe', 'shadow'],
  ['dry-run', 'shadow'],
  ['telemetry', 'shadow'],
  ['single', 'single'],
  ['enforce', 'single'],
  ['any', 'single'],
  ['all', 'single'],
  ['legacy', 'single'],
  ['consensus', 'consensus'],
  ['majority', 'consensus'],
  ['quorum', 'consensus'],
]);

/** Normalize an operator/config value to one of off|shadow|single|consensus. */
export function normalizeQualityMode(value, fallback = 'consensus') {
  const key = String(value ?? '').trim().toLowerCase();
  if (!key) return fallback;
  return _MODE_ALIASES.get(key) || fallback;
}

/**
 * Group quality vetoes by gate. Two reasons from the SAME gate count once:
 * the gate has already spoken; consensus is about independent agreement.
 *
 * @param {Array<{filter?:string, reason?:string, force?:boolean}>} vetoes
 * @returns {Array<{filter:string, reason:string, reasons:string[], force:boolean}>}
 */
export function groupQualityVetoes(vetoes = []) {
  const byFilter = new Map();
  for (const raw of Array.isArray(vetoes) ? vetoes : []) {
    if (!raw || raw.blocked === false) continue;
    const filter = String(raw.filter || 'quality').trim() || 'quality';
    const reason = String(raw.reason || '').trim();
    if (!reason) continue;
    const force = raw.force === true;
    const cur = byFilter.get(filter);
    if (!cur) {
      byFilter.set(filter, { filter, reason, reasons: [reason], force });
      continue;
    }
    if (!cur.reasons.includes(reason)) cur.reasons.push(reason);
    cur.reason = cur.reasons.join(' | ');
    cur.force = cur.force || force;
  }
  return [...byFilter.values()];
}

/**
 * The ONE quality-consensus verdict.
 *
 * @param {Array<{filter?:string, reason?:string, force?:boolean}>} vetoes
 * @param {{mode?:string, minVetoes?:number}} [opts]
 * @returns {{
 *   ok:boolean, blocked:boolean, mode:string, minVetoes:number,
 *   count:number, forced:boolean, vetoes:object[], warnings:object[],
 *   summary:string
 * }}
 */
export function combineQualityVerdicts(vetoes = [], opts = {}) {
  const mode = normalizeQualityMode(opts.mode, QUALITY_CONSENSUS_DEFAULTS.mode);
  const requested = Number(opts.minVetoes);
  const minVetoes = Number.isFinite(requested) && requested >= 1
    ? Math.min(QUALITY_CONSENSUS_DEFAULTS.maxVetoes, Math.floor(requested))
    : QUALITY_CONSENSUS_DEFAULTS.minVetoes;
  const grouped = groupQualityVetoes(vetoes);
  const forced = grouped.some(v => v.force === true);
  const count = grouped.length;
  const blocked = mode === 'single'
    ? count >= 1
    : mode === 'consensus'
      ? (forced || count >= minVetoes)
      : false;
  return {
    ok: !blocked,
    blocked,
    mode,
    minVetoes,
    count,
    forced,
    vetoes: grouped,
    warnings: blocked ? [] : grouped,
    summary: grouped.map(v => `${v.filter}: ${v.reason}`).join(' | '),
  };
}

// ------------------------------------------------------------
// Blocker classification helpers
// ------------------------------------------------------------
// A safety blocker is a structural contradiction: the ticket itself is
// invalid, the direction is unresolved, the plan is stale, price is already
// through the stop/target, or a hard veto flag is stamped on the row.
// Everything else that is timing/quality evidence belongs to the consensus.
const PRE_ENTRY_HARD = [
  /signal row unavailable/i,
  /plan unavailable/i,
  /incomplete entry\/stop ticket/i,
  /direction unresolved/i,
  /direction disagreement/i,
  /combined verdict/i,
  /engine conflict/i,
  /deep ensemble .* opposite lane/i,
  /trap veto/i,
  /zone wall veto/i,
  /action-TF reversal/i,
  /action-TF opposing flow/i,
  /post-peak late-entry trap/i,
  /entry overextended/i,
  /closed-bar reversal/i,
  /direction not PAKKA verified/i,
  /signal row .*stale/i,
  /live quote .* stale/i,
  /through the stop-loss/i,
  /target already/i,
];

const PRE_ENTRY_QUALITY = [
  /late chase/i,
  /reversal: live already/i,
  /structure break/i,
  /thesis already under water/i,
  // v21.44.1: momentum-weakening reasons are QUALITY evidence (vote), not a
  // structural contradiction — 'X×ATR adverse (weakening)' must join the
  // consensus instead of hard-blocking on its own.
  /atr adverse/i,
  /weakening/i,
];

export function isPreEntryHardBlocker(reason) {
  const s = String(reason || '');
  if (!s) return false;
  if (PRE_ENTRY_QUALITY.some(re => re.test(s))) return false;
  return PRE_ENTRY_HARD.some(re => re.test(s));
}

export function isPreEntryQualityBlocker(reason) {
  const s = String(reason || '');
  if (!s) return false;
  if (isPreEntryHardBlocker(s)) return false;
  return PRE_ENTRY_QUALITY.some(re => re.test(s));
}

const TIMING_HARD = [
  /direction unresolved/i,
  /direction disagreement/i,
  /direction certificate/i,
  /closed-bar reversal/i,
  /signal row .*stale/i,
  /entry overextended/i,
];

export function isEntryTimingHardBlocker(reason) {
  const s = String(reason || '');
  if (!s) return false;
  if (isEntryTimingQualityBlocker(s)) return false;
  return TIMING_HARD.some(re => re.test(s));
}

// Only the two risk-ratio timing reasons are quality evidence. Everything
// else the timing guard emits is direction/staleness/structure safety.
const TIMING_QUALITY = [
  /late chase/i,
  /reversal: live already/i,
];

export function isEntryTimingQualityBlocker(reason) {
  const s = String(reason || '');
  if (!s) return false;
  return TIMING_QUALITY.some(re => re.test(s));
}

const LIVE_QUALITY_HARD = [
  /direction not PAKKA/i,
  /invalid direction/i,
];

export function isLiveQualityHardBlocker(reason) {
  const s = String(reason || '');
  if (!s) return false;
  if (isLiveQualityQualityBlocker(s)) return false;
  return LIVE_QUALITY_HARD.some(re => re.test(s));
}

// The live-entry quality gate currently emits exactly two soft evidences:
// a stop inside the ATR noise band and 1-bar fading momentum.
const LIVE_QUALITY_QUALITY = [
  /noise stop-out/i,
  /momentum FADING/i,
];

export function isLiveQualityQualityBlocker(reason) {
  const s = String(reason || '');
  if (!s) return false;
  return LIVE_QUALITY_QUALITY.some(re => re.test(s));
}

/** Extreme numeric contradictions block alone, even in consensus mode. */
export function preEntryVetoIsForced(metrics = {}) {
  const chase = Number(metrics?.chaseRatio);
  const adverse = Number(metrics?.adverseRatio);
  return (Number.isFinite(chase) && chase > 0.5)
    || (Number.isFinite(adverse) && adverse > 0.4);
}

/**
 * Resolve the operator policy from env (wins) then a config object. Shared by
 * the auto tick and the manual lane so both lanes vote with the same rule.
 */
export function resolveQualityPolicy(cfg = {}) {
  const envMode = process.env.ENTRY_QUALITY_CONSENSUS;
  const mode = normalizeQualityMode(
    envMode != null && String(envMode).trim() !== '' ? envMode : cfg?.entryQualityConsensus,
    QUALITY_CONSENSUS_DEFAULTS.mode,
  );
  const envMin = Number(process.env.ENTRY_QUALITY_CONSENSUS_MIN);
  const rawMin = Number.isFinite(envMin) && envMin >= 1 ? envMin : Number(cfg?.entryQualityConsensusMin);
  const minVetoes = Number.isFinite(rawMin) && rawMin >= 1
    ? Math.min(QUALITY_CONSENSUS_DEFAULTS.maxVetoes, Math.floor(rawMin))
    : QUALITY_CONSENSUS_DEFAULTS.minVetoes;
  return { mode, minVetoes };
}

/**
 * Split a preEntryRecheck verdict into safety vs quality. Unrecognised reasons
 * are treated as SAFETY (fail closed), never as quality evidence.
 */
export function classifyPreEntryVerdict(verdict = {}) {
  const blockers = Array.isArray(verdict?.blockers) ? verdict.blockers.filter(Boolean) : [];
  const quality = blockers.filter(isPreEntryQualityBlocker);
  const hard = blockers.filter(b => !isPreEntryQualityBlocker(b));
  const vetoes = quality.length
    ? [{
      filter: 'preEntryRecheck',
      reason: quality.join(' | '),
      force: preEntryVetoIsForced(verdict?.metrics),
    }]
    : [];
  return { hard, quality, vetoes };
}

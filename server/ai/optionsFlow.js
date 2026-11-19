// ============================================================
// server/ai/optionsFlow.js — v21.42 OPTION-CHAIN FLOW READS
// ------------------------------------------------------------
// ONE pure module for the deterministic chain-direction tally and the
// card-side confluence score. Both the signal-card builder
// (optionsDesk.js) and the market-wide scanner (optionsScan.js) import
// from here, so there is exactly ONE engine and no import cycle.
//
//   directionRead(desk)        signed conviction tally
//   chainConfluence(desk, side) how strongly the live chain confirms CE/PE
// ============================================================

const r2 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

/** v21.43: ONE card tier ladder shared by the card builder and the
 *  FreeLLMAPI confirm layer (85 / 80 / 65 — superIntel language). */
export function optionTier(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return 'WATCH';
  return n >= 85 ? 'ELITE' : n >= 80 ? 'STRONG' : n >= 65 ? 'ACTION' : 'WATCH';
}

/**
 * PURE: deterministic direction read off the desk analytics.
 * Returns { pts, direction, why } — pts is a signed conviction tally:
 *   +1 puts being written (support)   · −1 calls being written (cap)
 *   +1 PCR > 1.2 (put-heavy = support floor) · −1 PCR < 0.7 (call chase)
 *   +1 spot above max-pain · −1 below
 *   +1 spot above gamma flip (positive-gamma zone) · −1 below
 */
export function directionRead(desk) {
  const a = desk?.analytics || {};
  const pts = [];
  const oiLean = a.flow?.oiLean;
  if (typeof oiLean === 'number' && Number.isFinite(oiLean)) {
    if (oiLean <= -0.15) pts.push(['PE writing — support ban raha hai', 1]);
    else if (oiLean >= 0.15) pts.push(['CE writing — upar cap lag raha hai', -1]);
  }
  const pcr = a.pcr;
  if (typeof pcr === 'number' && Number.isFinite(pcr)) {
    if (pcr >= 1.2) pts.push(['PCR ' + r2(pcr) + ' — put-heavy book (support floor)', 1]);
    else if (pcr <= 0.7) pts.push(['PCR ' + r2(pcr) + ' — call-heavy book (top pressure)', -1]);
  }
  if (typeof a.maxPain === 'number' && desk?.spot > 0 && a.maxPain > 0) {
    const off = (desk.spot - a.maxPain) / a.maxPain;
    if (off >= 0.005) pts.push(['spot max-pain ke upar — writers ko upar khinchne ka motive', 1]);
    else if (off <= -0.005) pts.push(['spot max-pain ke neeche — writers ko neeche khinchne ka motive', -1]);
  }
  const flip = a.gex?.gammaFlip;
  if (typeof flip === 'number' && desk?.spot > 0 && flip > 0) {
    const off = (desk.spot - flip) / flip;
    if (off >= 0.002) pts.push(['positive-GEX zone (gamma flip ke upar) — dealers move damp karte hain', 1]);
    else if (off <= -0.002) pts.push(['negative-GEX zone (gamma flip ke neeche) — move accelerate ho sakta hai', -1]);
  }
  const total = pts.reduce((s, [, v]) => s + v, 0);
  const direction = total >= 2 ? 'BULLISH' : total <= -2 ? 'BEARISH' : 'NEUTRAL';
  return { pts: total, direction, why: pts.map(([w]) => w) };
}

/**
 * v21.42: how strongly the LIVE option chain confirms a CE (LONG) or
 * PE (SHORT) card. Deterministic and explainable — every point traces
 * to PCR / OI-lean / max-pain / gamma-flip. Model chains return zero
 * (no OI, no honest confluence) with a warning instead of a fake score.
 */
export function chainConfluence(desk, side) {
  const liveChain = desk?.source === 'nse' || desk?.source === 'bse';
  if (!liveChain) {
    return {
      liveChain: false, aligned: false, opposed: false, pts: 0,
      direction: 'NEUTRAL', checks: [], score: 0,
      warnings: ['model-chain: OI/PCR/GEX unavailable — no chain confluence'],
    };
  }
  if (!desk?.analytics) {
    return {
      liveChain: true, aligned: false, opposed: false, pts: 0,
      direction: 'NEUTRAL', checks: [], score: 0,
      warnings: ['chain analytics unavailable — confluence neutral'],
    };
  }
  const read = directionRead(desk);
  const want = side === 'LONG' ? 1 : side === 'SHORT' ? -1 : 0;
  const signed = read.pts * want;
  const aligned = want !== 0 && signed >= 1;
  const opposed = want !== 0 && signed <= -1;
  // Aligned conviction adds up to +10; an opposed chain subtracts 10.
  // Neutral chains neither help nor hurt — silence is not confirmation.
  const score = aligned ? Math.min(10, 3 + Math.abs(read.pts) * 2) : opposed ? -10 : 0;
  return {
    liveChain: true,
    aligned, opposed,
    pts: read.pts,
    direction: read.direction,
    checks: read.why,
    score,
    warnings: opposed ? ['chain read card ke against hai — signal strength capped'] : [],
  };
}

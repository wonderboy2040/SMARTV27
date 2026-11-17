// ============================================================
// server/ai/sniperEntryEngine.js — v21.37.0 [ENTRY SNIPER]
// ------------------------------------------------------------
// TICK-TRIGGERED entry: ARMED + 75+ + eligible signals ka entry
// live tick par entry-zone hit hone par turant fire ho — 60s cycle
// ka intezaar nahi. Same safety gates as mtfAutoTick.
//
// WIRING: routes.js calls startSniper() once at boot, which
// subscribes to liveFeed.subscribe(). Each tick drives
// _sniperTick(symbol, tick, now).
//
// DEFAULT: OFF. Toggle via env MTF_AUTO_SNIPER=1 OR mtfAutoCfg
// field `sniperMode: true`. The regular mtfAutoTick 60s loop is
// NOT replaced — both can coexist (sniper tries to beat it).
//
// HONESTY: no fabricated 1ms feed. Entry latency = WebSocket
// tick arrival + local eval (<5ms). True 1ms fill requires colocation.
// ============================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { subscribe as subscribeLiveFeed, getTick as _getTick } from '../liveFeed.js';
import {
  loadMtfAutoCfg, saveMtfAutoCfg,
  _loadState as _loadMtfState, _saveState as _saveMtfState,
  DEFAULT_CFG,
} from './mtfAutoEntry.js';
import { loadConfig } from './coindcxOrders.js';
import { evaluateSpreadGate, estimateSlippageBps } from './entryQuality.js';
import {
  patientEntryEnabled, classifyEntry, pullbackLevelFor, levelTouched,
} from './patientEntry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CFG_FILE = () => path.join(_dataDir(), 'mtf-auto-config.json');

function _dataDir() {
  return process.env.SMARTAI_DATA_DIR
    ? path.resolve(process.env.SMARTAI_DATA_DIR)
    : path.resolve(__dirname, '..', 'data');
}

const SNIPER_TICK_COOLDOWN_MS = 150;
const SNIPER_PENDING_TTL_MS = 90_000;
const SNIPER_MAX_PENDING_PER_SYM = 1;
const SNIPER_MAX_ACTIVE_PENDING = 12;

let _running = false;
let _unsub = null;
const _pending = new Map();
const _lastTickAt = new Map();

function _now() { return Date.now(); }
function _key(sym, side) { return `${String(sym || '').toUpperCase()}|${String(side || '').toUpperCase()}`; }
function _cfg() { return loadMtfAutoCfg(); }
function _mtfState() { return _loadMtfState(); }
function _mtfSave(s) { _saveMtfState(s); }
function _tradingConfig() {
  try { return loadConfig(); } catch { return {}; }
}

export function sniperModeEnabled() {
  const env = String(process.env.MTF_AUTO_SNIPER || '').trim().toLowerCase();
  if (['1', 'true', 'on'].includes(env)) return true;
  if (['0', 'false', 'off'].includes(env)) return false;
  const cfg = _cfg();
  return cfg.sniperMode === true;
}

async function _loadBoards() {
  const boards = [];
  for (const market of ['INDIA', 'CRYPTO']) {
    for (const mode of Object.keys(DEFAULT_CFG.modes || { INTRADAY: 1, SWING: 1 })) {
      try {
        const { getMtfBoard } = await import('./mtfBoard.js');
        const b = await getMtfBoard(market, mode);
        if (b?.ok) boards.push(b);
      } catch { /* skip */ }
    }
  }
  return boards;
}

function _passesEntryQuality({ entry, sl, side, notionalINR, depthUSD = null, spreadBps = null } = {}) {
  const m = (k, def) => { const cfg = _cfg(); const v = cfg?.[k]; return v != null ? v : def; };
  const spread = evaluateSpreadGate({
    spreadBps: spreadBps ?? 8, spreadHistory: [],
    hardCap: m('spreadHardCapBps', 12), medianMult: m('spreadMedianMult', 2), medianWindow: m('spreadMedianWindow', 50),
  });
  if (!spread.ok) return { ok: false, reason: `spreadGate: ${spread.reason}` };
  const riskUSD = Math.abs(entry - sl) / entry * notionalINR;
  const slippageBps = estimateSlippageBps({
    notionalUSD: depthUSD ? notionalINR / 80 : notionalINR * 0.012,
    depthUSD: depthUSD || 50_000, spreadBps: spreadBps ?? 8,
    a: m('slippageModelA', 2), b: m('slippageModelB', 4), c: m('slippageModelC', 0.35),
  });
  const slipR = slippageBps / 10_000 * notionalINR / Math.max(1, riskUSD);
  if (slipR > (m('slippageMaxR', 0.15))) return { ok: false, reason: `slippageGate: ${slipR.toFixed(2)}R > ${m('slippageMaxR', 0.15)}R` };
  return { ok: true };
}

async function _sniperTick({ symbol, market, ltp, ts } = {}) {
  if (!sniperModeEnabled()) return;
  const cfg = _cfg();
  if (!cfg.enabled) return;
  const trading = _tradingConfig();
  if (trading?.killSwitch) return;
  const now = _now();
  const sym = String(symbol || '').toUpperCase();
  if (!sym || !(ltp > 0)) return;

  const boards = await _loadBoards();
  if (boards.length === 0) return;

  const minScore = Math.max(50, Number(cfg.minScore) || 75);
  const candidates = [];
  for (const b of boards) {
    for (const sig of (b.signals || [])) {
      if (String(sig?.symbol || '').toUpperCase() !== sym) continue;
      if (sig?.state !== 'ARMED') continue;
      if (sig.stale) continue;
      const aiScore = Number(sig.super?.aiScore ?? sig.superIntel?.aiScore ?? 0);
      if (aiScore < minScore) continue;
      if (!sig.autoTrade?.eligible) continue;
      const act = sig.action || {};
      const entry = Number(act.entry), sl = Number(act.stopLoss);
      const t1 = Number(act.target1);
      const side = String(sig.side || '').toUpperCase();
      if (!(entry > 0) || !(sl > 0) || !(t1 > 0)) continue;
      if (side === 'LONG' && (sl >= entry || t1 <= entry)) continue;
      if (side === 'SHORT' && (sl <= entry || t1 >= entry)) continue;
      candidates.push({ sig, board: b, aiScore, entry, sl, t1, side, market: sig.market, mode: sig.mode });
    }
  }
  if (candidates.length === 0) return;
  const pick = candidates.sort((a, b) => b.aiScore - a.aiScore)[0];
  const k = _key(sym, pick.side);

  const last = _lastTickAt.get(k) || 0;
  if (now - last < SNIPER_TICK_COOLDOWN_MS) return;
  _lastTickAt.set(k, now);

  const mstate = _mtfState();
  let openSet = new Set();
  try {
    const { getPaperSummary } = await import('../intraday/paperTrading.js');
    const sum = getPaperSummary();
    openSet = new Set((sum?.open || []).map(t => `${String(t.symbol || '').toUpperCase()}|${String(t.direction || '').toUpperCase()}`));
  } catch { /* paper engine handles its own dedupe */ }
  if (openSet.has(k)) return;
  if (_pending.has(k)) return;
  if (Number((mstate.perSymbol || {})[sym] || 0) >= Number(cfg.perSymbolPerDay || 2)) return;
  const lastEntryAt = Number((mstate.lastEntryAt || {})[sym] || 0);
  if (lastEntryAt > 0 && (now - lastEntryAt) < Number(cfg.cooldownMin || 15) * 60_000) return;
  if (Number(mstate.count || 0) >= Number(cfg.quotaPerDay || 6)) return;

  const atr = Number(pick.sig.plan?.atr || pick.sig.quality?.atr || 0);
  const retestBand = atr > 0 ? 0.10 * atr : ltp * 0.0015;
  const sideUpper = String(pick.side || '').toUpperCase();
  const inZone = sideUpper === 'LONG'
    ? (ltp <= pick.entry + retestBand && ltp >= pick.entry - retestBand)
    : (ltp >= pick.entry - retestBand && ltp <= pick.entry + retestBand);

  const patient = patientEntryEnabled(cfg);
  const entryMode = classifyEntry({ ltp, entry: pick.entry, atr });
  const useLimit = patient && (entryMode === 'EXTENDED' || entryMode === 'AT_ANCHOR');

  if (!inZone && !useLimit) return;

  const fx = pick.market === 'CRYPTO' ? (ltp / pick.entry) : 1;
  const notionalINR = Number(pick.market === 'CRYPTO' ? (cfg.notionalUSDT || 100) * fx : cfg.notionalINR || 20000);
  const eq = _passesEntryQuality({ entry: pick.entry, sl: pick.sl, side: pick.side, notionalINR, depthUSD: 50_000, spreadBps: 8 });
  if (!eq.ok) return;

  if (useLimit && !inZone) {
    if (_pending.size >= SNIPER_MAX_ACTIVE_PENDING) return;
    const restingLevel = pullbackLevelFor({ side: pick.side, ltp, entry: pick.entry, depth: null });
    if (!restingLevel || _pending.has(k)) return;
    const timer = setTimeout(() => _cancelPending(k, 'expiry'), SNIPER_PENDING_TTL_MS);
    if (timer.unref) timer.unref();
    _pending.set(k, {
      at: now, sig: pick.sig, board: pick.board, ltp,
      retestLevel: restingLevel, ttlTimer: timer,
      side: pick.side, market: pick.market, mode: pick.mode,
      entry: pick.entry, sl: pick.sl, t1: pick.t1, t2: pick.sig.action?.target2,
    });
    return;
  }

  if (_pending.has(k)) {
    const p = _pending.get(k);
    if (levelTouched({ side: p.side, level: p.retestLevel, ltp })) {
      _cancelPending(k, 'fill');
      const qty = _qtyFor(p.retestLevel, p.market, cfg);
      if (qty) {
        await _executeSniperEntry({
          symbol: sym, side: p.side, market: p.market, mode: p.mode,
          entry: p.retestLevel, sl: p.sl, t1: p.t1, t2: p.t2, qty,
          score: pick.aiScore,
          label: `MTF SNIPER ${p.mode} · SUPER ${pick.aiScore} · LIMIT-FILL`,
        });
      }
    }
    return;
  }

  if (inZone) {
    const qty = _qtyFor(pick.entry, pick.market, cfg);
    if (!qty) return;
    await _executeSniperEntry({
      symbol: sym, side: pick.side, market: pick.market, mode: pick.mode,
      entry: pick.entry, sl: pick.sl, t1: pick.t1, t2: pick.sig.action?.target2, qty,
      score: pick.aiScore,
      label: `MTF SNIPER ${pick.mode} · SUPER ${pick.aiScore} · TICK`,
    });
  }
}

async function _executeSniperEntry({ symbol, side, market, mode, entry, sl, t1, t2, qty, label, score = 0 }) {
  try {
    const { openPaperTrade } = await import('../intraday/paperTrading.js');
    // `board` was referenced here (v21.37.0 first cut) but is not in scope —
    // it threw a ReferenceError that the catch swallowed, so NO sniper entry
    // ever executed. The score now comes from the caller.
    const res = openPaperTrade({ symbol, direction: side, entry, qty, stopLoss: sl, target1: t1, target2: t2, market, label, source: 'sniper', sourceMeta: { score: Number(score || 0), mode } });
    if (res?.error) return;
    const s = _mtfState();
    const sym = String(symbol || '').toUpperCase();
    s.count = Number(s.count || 0) + 1;
    s.perSymbol = { ...(s.perSymbol || {}), [sym]: Number((s.perSymbol || {})[sym] || 0) + 1 };
    s.lastEntryAt = { ...(s.lastEntryAt || {}), [sym]: _now() };
    s.lastEntry = { at: _now(), symbol: sym, market, mode, side, entry, stopLoss: sl, target1: t1, target2: t2, qty, label, sniper: true };
    _mtfSave(s);
  } catch { /* never fatal */ }
}

function _cancelPending(k, reason) {
  const p = _pending.get(k);
  if (!p) return;
  try { if (p.ttlTimer) clearTimeout(p.ttlTimer); } catch { /* timer already gone */ }
  _pending.delete(k);
}

function _qtyFor(entry, market, cfg) {
  if (!(entry > 0)) return null;
  const notional = market === 'CRYPTO' ? Number(cfg.notionalUSDT || 100) : Number(cfg.notionalINR || 20000);
  const q = market === 'CRYPTO' ? +(notional / entry).toFixed(4) : Math.floor(notional / entry);
  return q > 0 ? q : null;
}

export function startSniper() {
  if (_running) return;
  if (!sniperModeEnabled()) return;
  _running = true;
  _unsub = subscribeLiveFeed(async (key, tick) => {
    try {
      await _sniperTick({
        symbol: tick?.symbol || key?.replace(/^IN_|^US_/, ''),
        market: key?.startsWith('US_') ? 'INDIA' : 'CRYPTO',
        // liveFeed stores the last price in `price` and the timestamp in `time`
        // (see liveFeed.setTick). Reading `ltp`/`last`/`mark`/`ts` — fields that
        // don't exist on the tick — made ltp 0, so _sniperTick bailed early on
        // every tick and the armed sniper never evaluated a single entry.
        ltp: Number(tick?.price || tick?.ltp || tick?.last || tick?.mark || 0),
        ts: Number(tick?.time || tick?.ts || 0),
      });
    } catch { /* never breaks liveFeed subscriber loop */ }
  });
}

export function stopSniper() {
  if (_unsub) { try { _unsub(); } catch { /* already unsubscribed */ } _unsub = null; }
  _running = false;
  for (const [k, p] of _pending) _cancelPending(k, 'stop');
  _pending.clear();
  _lastTickAt.clear();
}

export function sniperStatus() {
  return { enabled: sniperModeEnabled(), running: _running, pending: _pending.size, pendingKeys: Array.from(_pending.keys()) };
}

export function __resetSniperForTests() { stopSniper(); }

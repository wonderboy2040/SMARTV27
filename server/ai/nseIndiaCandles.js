// ============================================================
// server/ai/nseIndiaCandles.js — NSE MCP + Groww Realtime India Data
// ------------------------------------------------------------
// Replaces Yahoo Finance for INDIA market with:
//   1. NSE MCP (nseindia.in/nse-mcp) — candles, quotes, market status
//   2. Groww SSE stream — realtime 1-2s tick overlay
//   3. NSE direct API — fallback for option-chain + depth
//
// Candle TTLs (replaces YF_TTL):
//   1m: 60s | 5m: 90s | 15m: 120s | 1h: 300s | 1d: 600s
//
// Yahoo Finance COMPLETELY REMOVED from the India chain.
// ============================================================

import { listNseMcpTools, callNseMcpTool, nseMcpHealth, __noteNseMcpFail, __noteNseMcpSuccess } from './nseMcp.js';
import { nseWindow } from '../inStream.js';
import { isNseMarketOpen as isNseOpen } from '../intraday/time.js';
import { computeIndicatorsFromCandles } from './lib/indicators.js';
import { ensureAscending } from './lib/candles.js';

const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const num = (v) => (Number.isFinite(v) ? v : null);

// ---------------- caches ----------------

const _candleCache = new Map();
const CANDLE_TTL_MS = {
  '1m': 60_000,
  '5m': 90_000,
  '15m': 120_000,
  '1h': 300_000,
  '4h': 300_000,
  '1d': 600_000,
};
const CANDLE_CACHE_MAX = 96;

// ---------------- TV scanner cache ----------------

const _tvCache = new Map();
const TV_TTL_MS = 60_000;
const TV_CACHE_MAX = 80;

// ---------------- NSE direct API ----------------

const NSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.nseindia.com/option-chain',
};

let _nseCookie = null;
let _nseCookieAt = 0;
const NSE_COOKIE_TTL = 8 * 60_1000;

async function nseBootstrapCookies() {
  if (_nseCookie && Date.now() - _nseCookieAt < NSE_COOKIE_TTL) return _nseCookie;
  try {
    const r = await fetch('https://www.nseindia.com/option-chain', {
      headers: NSE_HEADERS,
      signal: AbortSignal.timeout(8000),
    });
    const sc = r.headers.get('set-cookie');
    if (sc) _nseCookie = sc.split(',').map(c => c.split(';')[0].trim()).join('; ');
    _nseCookieAt = Date.now();
    return _nseCookie;
  } catch {
    return null;
  }
}

async function nseFetch(path) {
  const cookie = await nseBootstrapCookies();
  const r = await fetch(`https://www.nseindia.com${path}`, {
    headers: { ...NSE_HEADERS, ...(cookie ? { Cookie: cookie } : {}) },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`NSE ${r.status}`);
  return r.json();
}

// ---------------- Groww SSE integration ----------------

import { growwTick, subscribeSymbols as growwSubscribe, startGrowwStream } from './growwStream.js';

// Kick off Groww stream lazily on first India data request
let _growwStarted = false;

function ensureGrowwStream(symbols) {
  if (_growwStarted) return;
  _growwStarted = true;
  startGrowwStream(symbols || [], 'nse');
}

// ---------------- NSE MCP candle fetcher ----------------

export async function fetchNseMcpCandles(symbol, tf, limit = 300) {
  const sym = String(symbol || '').toUpperCase().replace(/\.NS$/, '');
  if (!sym) return null;

  const cacheKey = `nse:${sym}:${tf}:${limit}`;
  const ttl = CANDLE_TTL_MS[tf] || 120_000;
  const hit = _candleCache.get(cacheKey);
  if (hit && Date.now() - hit.at < ttl) return hit.candles.slice();

  // Try NSE MCP first
  const mcpResult = await callNseMcpTool('nse_candles', { symbol: sym, timeframe: tf, limit }, ttl);
  if (mcpResult) {
    const candles = normalizeCandles(mcpResult, tf);
    if (candles && candles.length >= 30) {
      _candlesCacheSet(cacheKey, candles);
      __noteNseMcpSuccess();
      return candles.slice();
    }
  }

  // Fallback: NSE direct API
  try {
    const nseResult = await fetchNseCandlesDirect(sym, tf, limit);
    if (nseResult && nseResult.length >= 30) {
      _candlesCacheSet(cacheKey, nseResult);
      return nseResult.slice();
    }
  } catch { /* NSE direct path failed — fall through to honest null */ }

  _candlesCacheSet(cacheKey, null);
  return null;
}

function _candlesCacheSet(key, candles) {
  _candleCache.set(key, { at: Date.now(), candles });
  while (_candleCache.size > CANDLE_CACHE_MAX) {
    const k = _candleCache.keys().next().value;
    if (k === undefined) break;
    _candleCache.delete(k);
  }
}

function normalizeCandles(data, tf) {
  if (!data || typeof data !== 'object') return null;

  // Shape A: { candles: [{time, open, high, low, close, volume}, ...] }
  if (Array.isArray(data.candles)) {
    return data.candles
      .map(c => ({
        time: Number(c.time || c.timestamp || c.date) * (c.time < 1e12 ? 1000 : 1),
        open: num(c.open),
        high: num(c.high),
        low: num(c.low),
        close: num(c.close),
        volume: Number(c.volume || c.vol || 0),
      }))
      .filter(c => c.close > 0 && c.open > 0)
      .sort((a, b) => a.time - b.time);
  }

  // Shape B: [{t, o, h, l, c, v}, ...]
  if (Array.isArray(data) && data.length > 0 && data[0].t !== undefined) {
    return data
      .map(c => ({
        time: Number(c.t) < 1e12 ? Number(c.t) * 1000 : Number(c.t),
        open: num(c.o), high: num(c.h), low: num(c.l), close: num(c.c),
        volume: Number(c.v || c.volume || 0),
      }))
      .filter(c => c.close > 0 && c.open > 0)
      .sort((a, b) => a.time - b.time);
  }

  return null;
}

async function fetchNseCandlesDirect(symbol, tf, limit) {
  // NSE candles endpoint
  const tfMap = { '1m': '1', '5m': '5', '15m': '15', '1h': '60', '1d': '1' };
  const nseTf = tfMap[tf] || '15';
  const url = `https://www.nseindia.com/api/historical/equity?symbol=${encodeURIComponent(symbol)}&from=${new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)}&to=${new Date().toISOString().slice(0, 10)}`;

  try {
    const data = await nseFetch(url);
    if (!data?.data || !Array.isArray(data.data)) return null;

    // NSE historical format: {date, open, high, low, close, volume, ...}
    return data.data
      .slice(-limit)
      .map(r => ({
        time: new Date(r.date).getTime(),
        open: num(r.open), high: num(r.high), low: num(r.low), close: num(r.close),
        volume: Number(r.totalTradedVolume || r.volume || 0),
      }))
      .filter(c => c.close > 0 && c.open > 0)
      .sort((a, b) => a.time - b.time);
  } catch {
    return null;
  }
}

// ---------------- Public: India scanner quotes ----------------

export async function fetchIndiaQuotesMcp(symbols) {
  if (!Array.isArray(symbols) || symbols.length === 0) return {};

  const health = nseMcpHealth();
  if (!health.available) return {};

  const results = {};
  const BATCH = 5;

  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH);
    const settled = await Promise.allSettled(
      batch.map(async (sym) => {
        const quote = await callNseMcpTool('nse_quote', { symbol: sym.toUpperCase() }, 4000);
        if (quote) return { sym, quote };
        return null;
      })
    );

    for (const s of settled) {
      if (s.status === 'fulfilled' && s.value?.quote) {
        const { sym, quote } = s.value;
        results[sym] = normalizeQuote(quote);
        __noteNseMcpSuccess();
      } else {
        __noteNseMcpFail();
      }
    }
  }

  return results;
}

function normalizeQuote(data) {
  if (!data || typeof data !== 'object') return null;
  const pf = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    symbol: String(data.symbol || data.tradingSymbol || '').toUpperCase(),
    ltp: pf(data.ltp ?? data.lastPrice ?? data.price),
    open: pf(data.open ?? data.openPrice),
    high: pf(data.high ?? data.dayHigh),
    low: pf(data.low ?? data.dayLow),
    close: pf(data.close ?? data.previousClose),
    volume: Number(data.volume ?? data.totalVolume ?? 0),
    changePct: pf(data.changePercent ?? data.dayChangePct ?? data.pChange),
    change: pf(data.change ?? data.dayChange),
    exchange: data.exchange || 'NSE',
    source: 'nse-mcp',
  };
}

// ---------------- Groww overlay for India candles ----------------

export function applyGrowwOverlay(symbol, candles, tf) {
  if (!Array.isArray(candles) || candles.length === 0) return candles;

  const sym = String(symbol || '').toUpperCase().replace(/\.NS$/, '');
  if (!sym) return candles;

  const tick = growwTick(sym);
  if (!tick || !(tick.price > 0)) return candles;

  const tfMs = { '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000, '1d': 86400000 }[tf] || 900000;
  const last = candles[candles.length - 1];
  const lastTime = Number(last?.time || 0);
  const tickTime = Number(tick.time || Date.now());

  // Same bar → overlay
  if (tickTime >= lastTime && tickTime < lastTime + tfMs) {
    const updated = candles.slice();
    updated[updated.length - 1] = {
      ...last,
      close: tick.price,
      high: Math.max(last.high || 0, tick.high || tick.price),
      low: Math.min(last.low || Infinity, tick.low || tick.price),
      volume: (last.volume || 0) + (tick.volume || 0),
    };
    return updated;
  }

  // New bar → roll
  const newBar = {
    time: lastTime + tfMs,
    open: tick.price,
    high: tick.high || tick.price,
    low: tick.low || tick.price,
    close: tick.price,
    volume: tick.volume || 0,
  };
  return [...candles, newBar];
}

// ---------------- Unified India candle fetcher ----------------

export async function fetchIndiaCandles(symbol, tf, limit = 300) {
  const sym = String(symbol || '').toUpperCase().replace(/\.NS$/, '').replace(/\.BO$/, '');
  if (!sym) return null;

  const cacheKey = `india:${sym}:${tf}:${limit}`;
  const ttl = CANDLE_TTL_MS[tf] || 120_000;
  const hit = _candleCache.get(cacheKey);
  if (hit && Date.now() - hit.at < ttl) {
    return applyGrowwOverlay(sym, hit.candles?.slice(), tf);
  }

  // Path 1: NSE MCP candles
  let candles = await fetchNseMcpCandles(sym, tf, limit);

  // Path 2: NSE direct API (if MCP fails)
  if (!candles) {
    try {
      candles = await fetchNseCandlesDirect(sym, tf, limit);
    } catch { /* direct fallback failed — caller handles null */ }
  }

  if (!candles || candles.length < 30) {
    _candleCache.set(cacheKey, { at: Date.now(), candles: null });
    return null;
  }

  _candleCache.set(cacheKey, { at: Date.now(), candles: candles.slice() });

  // Ensure Groww stream is running for this symbol
  ensureGrowwStream([sym]);

  // Apply Groww realtime overlay
  return applyGrowwOverlay(sym, candles.slice(), tf);
}

// ---------------- India intraday scanner ----------------

export async function fetchIndiaScanner(symbols) {
  if (!Array.isArray(symbols) || symbols.length === 0) return {};

  // Try NSE MCP scanner tool first
  const health = nseMcpHealth();
  if (health.available) {
    try {
      const mcpScan = await callNseMcpTool('nse_scanner', { symbols: symbols.map(s => s.toUpperCase()) }, 10000);
      if (mcpScan && typeof mcpScan === 'object') {
        const out = {};
        for (const [sym, row] of Object.entries(mcpScan)) {
          out[sym] = normalizeScannerRow(sym, row);
        }
        if (Object.keys(out).length > 0) {
          __noteNseMcpSuccess();
          return out;
        }
      }
    } catch (err) {
      __noteNseMcpFail();
    }
  }

  // Fallback: individual quotes via NSE MCP
  return fetchIndiaQuotesMcp(symbols);
}

function normalizeScannerRow(symbol, data) {
  if (!data || typeof data !== 'object') return null;
  const pf = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    symbol: String(symbol || data.symbol || '').toUpperCase(),
    exchange: data.exchange || 'NSE',
    ltp: pf(data.ltp ?? data.lastPrice ?? data.price),
    open: pf(data.open),
    high: pf(data.high),
    low: pf(data.low),
    close: pf(data.close ?? data.previousClose),
    volume: Number(data.volume ?? data.totalVolume ?? 0),
    changePct: pf(data.changePercent ?? data.dayChangePct ?? data.pChange),
    change: pf(data.change ?? data.dayChange),
    ema10: pf(data.ema10), ema20: pf(data.ema20), ema50: pf(data.ema50),
    sma20: pf(data.sma20), sma50: pf(data.sma50),
    rsi: pf(data.rsi), macd: pf(data.macd), macdSignal: pf(data.macdSignal),
    atr: pf(data.atr), vwap: pf(data.vwap),
    adx: pf(data.adx), adxPlus: pf(data.adxPlus), adxMinus: pf(data.adxMinus),
    relVolume: pf(data.relative_volume_10d_calc ?? data.relVolume),
    pivot: data.pivot ? { p: pf(data.pivot.p), s1: pf(data.pivot.s1), r1: pf(data.pivot.r1) } : null,
    bbUpper: pf(data.bbUpper), bbLower: pf(data.bbLower),
    stochK: pf(data.stochK), stochD: pf(data.stochD),
    high52w: pf(data.high52w), low52w: pf(data.low52w),
    recommend: pf(data.recommend),
    source: 'nse-mcp',
  };
}

// ---------------- Staleness gate ----------------

export function isStaleIndiaSeries(rows, tf, { sessionOpen = null, now = Date.now() } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return false;
  // Explicit sessionOpen (tests / callers with their own NSE calendar) wins;
  // otherwise fall back to the live session window. Market closed → legitimate
  // old data (previous session's candles are not "stale").
  const open = sessionOpen == null ? nseWindow() : Boolean(sessionOpen);
  if (!open) return false;

  const nowMs = Number(now) > 0 ? Number(now) : Date.now();
  const tfMs = { '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000, '1d': 86400000 }[tf] || 900000;
  const lastBarAt = Number(rows[rows.length - 1]?.time || 0);
  if (!(lastBarAt > 0)) return false;
  return nowMs - lastBarAt > 3 * tfMs + 10 * 60_000;
}

// ---------------- Test hooks ----------------

export function __clearNseCandlesCache() { _candleCache.clear(); }
export function __clearNseTvCache() { _tvCache.clear(); }

// ============================================================
// server/ai/growwStream.js — Groww NSE/BSE Realtime SSE Stream
// ------------------------------------------------------------
// USER REQUEST: "NSE and BSE ka realtime data Groww se lein"
//
// Groww exposes a free SSE (Server-Sent Events) endpoint with live
// NSE/BSE quotes streaming at ~2-3s intervals. This module:
//   - Maintains a persistent SSE connection to Groww
//   - Tracks subscribed symbols in a Set
//   - Writes latest ticks into the shared liveFeed store
//   - Auto-reconnects with exponential backoff
//
// DATA FLOW:
//   Groww SSE → growwStream.js → liveFeed.js → SSE /api/stream
//                                    → inStream.js (3s poller)
//                                    → board/signals (via fetchYahooIntradayCandles)
//
// SYMBOL FORMAT: Groww uses plain NSE symbols (RELIANCE, INFY, etc.)
// The stream automatically prefixes IN_ for the liveFeed key.
// ============================================================

const GROWW_SSE_URL = 'https://groww.in/api/v1/market/nse/quotes/stream';
const GROWW_BSE_URL = 'https://groww.in/api/v1/market/bse/quotes/stream';
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const HEARTBEAT_MS = 15000;

let _es = null;
const _subscribed = new Set();
let _reconnectTimer = null;
let _reconnectDelay = RECONNECT_BASE_MS;
let _lastActivity = Date.now();
const _health = { connected: false, reconnects: 0, lastError: null };
let _onTick = null; // callback for tests/debug

// Internal tick store (mirrors liveFeed shape for direct consumers)
const _ticks = new Map();

export function growwTick(symbol) {
  const key = `IN_${String(symbol || '').toUpperCase()}`;
  return _ticks.get(key) || null;
}

export function growwTicksAll() {
  return Object.fromEntries(_ticks);
}

export function growwStreamHealth() {
  return {
    ..._health,
    subscribedCount: _subscribed.size,
    uptimeMs: _health.connected ? Date.now() - _lastActivity : 0,
  };
}

// ---------------- SSE management ----------------

function connect(exchange = 'nse') {
  if (_es) {
    _es.close();
    _es = null;
  }

  const url = exchange === 'bse' ? GROWW_BSE_URL : GROWW_SSE_URL;
  const symbols = Array.from(_subscribed);

  // Build URL with query params for subscription
  const qs = new URLSearchParams();
  if (symbols.length > 0) {
    qs.set('symbols', symbols.join(','));
  }
  qs.set('source', 'smartai-trading-suite');

  const fullUrl = `${url}?${qs.toString()}`;

  // Node < 22 has no global EventSource. Fail honestly instead of throwing
  // a ReferenceError that the reconnect timer would retry forever.
  if (typeof EventSource === 'undefined') {
    _health.connected = false;
    _health.lastError = 'EventSource unsupported in this Node runtime';
    return;
  }

  try {
    _es = new EventSource(fullUrl, { withCredentials: false });

    _es.onopen = () => {
      _health.connected = true;
      _health.lastError = null;
      _reconnectDelay = RECONNECT_BASE_MS;
      _lastActivity = Date.now();
      console.log(`[growwStream] connected (${exchange}, ${symbols.length} symbols)`);
    };

    _es.onerror = (err) => {
      _health.connected = false;
      _health.lastError = err.type || 'unknown';
      _health.reconnects++;
      _es.close();
      _es = null;
      scheduleReconnect(exchange);
    };

    _es.addEventListener('quote', (e) => {
      _lastActivity = Date.now();
      try {
        const data = JSON.parse(e.data);
        handleQuote(data);
      } catch { /* malformed quote frame — skip */ }
    });

    _es.addEventListener('tick', (e) => {
      _lastActivity = Date.now();
      try {
        const data = JSON.parse(e.data);
        handleQuote(data);
      } catch { /* malformed tick frame — skip */ }
    });

    _es.addEventListener('message', (e) => {
      _lastActivity = Date.now();
      try {
        const data = JSON.parse(e.data);
        handleQuote(data);
      } catch { /* malformed message frame — skip */ }
    });

    // Heartbeat
    _es.onmessage = (e) => {
      if (e.data === 'heartbeat' || e.data === 'ping') return;
      _lastActivity = Date.now();
    };

  } catch (err) {
    _health.connected = false;
    _health.lastError = err.message;
    scheduleReconnect(exchange);
  }
}

function handleQuote(data) {
  const sym = String(data?.symbol || data?.tradingSymbol || '').toUpperCase();
  if (!sym) return;

  const price = Number(data?.ltp ?? data?.price ?? data?.lastPrice);
  if (!(price > 0)) return;

  const key = `IN_${sym}`;
  const tick = {
    price,
    change: Number(data?.change ?? data?.dayChange ?? 0),
    changePct: Number(data?.changePercent ?? data?.dayChangePct ?? 0),
    high: Number(data?.high ?? data?.highPrice ?? price),
    low: Number(data?.low ?? data?.lowPrice ?? price),
    volume: Number(data?.volume ?? data?.totalVolume ?? 0),
    time: Number(data?.timestamp ?? data?.lastTradeTime ?? Date.now()),
    source: 'groww-sse',
    exchange: data?.exchange || 'NSE',
  };

  _ticks.set(key, tick);

  // Also write to shared liveFeed if available
  try {
    if (typeof globalThis.__smartAiLiveFeedWrite === 'function') {
      globalThis.__smartAiLiveFeedWrite(key, tick);
    }
  } catch { /* quote tap write is optional */ }

  if (_onTick) _onTick(sym, tick);
}

function scheduleReconnect(exchange) {
  if (_reconnectTimer) return;
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    _reconnectDelay = Math.min(_reconnectDelay * 2, RECONNECT_MAX_MS);
    connect(exchange);
  }, _reconnectDelay);
}

// ---------------- Subscription management ----------------

export function subscribeSymbols(symbols, exchange = 'nse') {
  const list = Array.isArray(symbols) ? symbols : [symbols];
  let changed = false;

  for (const s of list) {
    const sym = String(s || '').toUpperCase().replace(/\.(NS|BO)$/, '');
    if (!sym) continue;
    if (!_subscribed.has(sym)) {
      _subscribed.add(sym);
      changed = true;
    }
  }

  if (changed && _health.connected) {
    // Reconnect with updated subscription
    connect(exchange);
  } else if (changed && !_health.connected) {
    connect(exchange);
  }
}

export function unsubscribeSymbols(symbols) {
  const list = Array.isArray(symbols) ? symbols : [symbols];
  let changed = false;

  for (const s of list) {
    const sym = String(s || '').toUpperCase().replace(/\.(NS|BO)$/, '');
    if (_subscribed.has(sym)) {
      _subscribed.delete(sym);
      changed = true;
    }
  }

  if (changed && _health.connected) {
    connect('nse');
  }
}

// ---------------- Boot ----------------

export function startGrowwStream(initialSymbols = [], exchange = 'nse') {
  if (initialSymbols.length > 0) {
    for (const s of initialSymbols) _subscribed.add(String(s).toUpperCase().replace(/\.(NS|BO)$/, ''));
  }
  connect(exchange);

  // Heartbeat watchdog
  setInterval(() => {
    if (_health.connected && Date.now() - _lastActivity > HEARTBEAT_MS * 2) {
      console.warn('[growwStream] no activity for 30s, reconnecting');
      _health.connected = false;
      connect(exchange);
    }
  }, HEARTBEAT_MS);
}

export function stopGrowwStream() {
  if (_reconnectTimer) {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }
  if (_es) {
    _es.close();
    _es = null;
  }
  _health.connected = false;
  _subscribed.clear();
  _ticks.clear();
}

// Test hooks
export function __setGrowwTickCallback(fn) { _onTick = fn; }
export function __injectGrowwTick(symbol, data) {
  handleQuote({ symbol, ...data });
}

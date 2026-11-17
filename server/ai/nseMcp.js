// ============================================================
// server/ai/nseMcp.js — NSE MCP Client (nseindia.in/nse-mcp)
// ------------------------------------------------------------
// Connects to NSE's Model Context Protocol server at
// https://www.nseindia.in/nse-mcp for realtime India equity data.
//
// TRANSPORT: MCP Streamable HTTP (JSON-RPC 2.0)
//   POST https://www.nseindia.in/nse-mcp
//   Content-Type: application/json
//   Mcp-Session-Id header for session continuity
//
// TOOLS discovered at runtime via tools/list. Expected capabilities:
//   - NSE/BSE quotes (LTP, change, OHLC)
//   - Candle data (various TFs)
//   - Market status / session info
//   - Option chain (NIFTY/BANKNIFTY)
//
// AUTH: No API key required (public MCP endpoint).
// Rate-limited by NSE — we cache aggressively + circuit-break.
//
// CACHE STRATEGY:
//   - quotes: 3s hot cache (realtime-appropriate)
//   - candles: 60s warm cache (TA doesn't change intra-bar)
//   - tools/list: 10min cold cache
// ============================================================

const NSE_MCP_URL = 'https://www.nseindia.in/nse-mcp';
const MCP_TIMEOUT_MS = 12_000;
const TOOLS_TTL = 10 * 60_000;

let _sessionId = null;
let _tools = null;
let _toolsAt = 0;
let _toolCache = new Map(); // toolName -> { at, result }

// ---------------- MCP JSON-RPC helpers ----------------

async function mcpCall(method, params = {}, retry = true) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  if (_sessionId) headers['Mcp-Session-Id'] = _sessionId;

  const body = {
    jsonrpc: '2.0',
    id: Date.now() + Math.random(),
    method,
    params,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MCP_TIMEOUT_MS);

  try {
    const res = await fetch(NSE_MCP_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    // Capture session ID from response header
    const sid = res.headers.get('mcp-session-id');
    if (sid) _sessionId = sid;

    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (data.error) {
      const msg = data.error.message || String(data.error);
      throw new Error(`NSE MCP ${method} error: ${msg}`);
    }
    return data.result;
  } catch (err) {
    if (retry && err.name === 'AbortError') {
      return mcpCall(method, params, false);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------- Session lifecycle ----------------

async function ensureSession() {
  if (_sessionId) return true;
  try {
    const result = await mcpCall('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'SmartAI-Trading-Suite', version: '21.37.0' },
    }, true);
    _sessionId = result?.sessionId || null;
    if (_sessionId) {
      try { await mcpCall('notifications/initialized', {}); } catch { /* optional MCP notification */ }
      return true;
    }
    // Some servers don't return sessionId on initialize but still work
    return true;
  } catch (err) {
    _sessionId = null;
    console.warn('[nseMcp] initialize failed:', err.message);
    return false;
  }
}

// ---------------- Tools discovery ----------------

export async function listNseMcpTools(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _tools && now - _toolsAt < TOOLS_TTL) return _tools;

  try {
    const sessionOk = await ensureSession();
    if (!sessionOk) return null;

    const result = await mcpCall('tools/list', {});
    _tools = result?.tools || null;
    _toolsAt = now;
    return _tools;
  } catch (err) {
    console.warn('[nseMcp] tools/list failed:', err.message);
    return _tools || null;
  }
}

// ---------------- Tool calls ----------------

export async function callNseMcpTool(toolName, args = {}, ttlMs = 3000) {
  const cacheKey = `${toolName}:${JSON.stringify(args)}`;
  const now = Date.now();
  const hit = _toolCache.get(cacheKey);
  if (hit && now - hit.at < ttlMs) return hit.result;

  try {
    const sessionOk = await ensureSession();
    if (!sessionOk) return null;

    const result = await mcpCall('tools/call', {
      name: toolName,
      arguments: args,
    });

    const parsed = _parseToolResult(result);
    _toolCache.set(cacheKey, { at: now, result: parsed });
    return parsed;
  } catch (err) {
    console.warn(`[nseMcp] tool ${toolName} failed:`, err.message);
    return null;
  }
}

function _parseToolResult(result) {
  if (!result || typeof result !== 'object') return result;

  // MCP tool/call result: { content: [{ type: 'text', text: '...' }] }
  const content = result.content;
  if (Array.isArray(content)) {
    const textParts = [];
    for (const item of content) {
      if (item?.type === 'text' && typeof item.text === 'string') {
        textParts.push(item.text);
      } else if (item?.type === 'resource') {
        textParts.push(JSON.stringify(item));
      }
    }
    if (textParts.length === 1) {
      try { return JSON.parse(textParts[0]); }
      catch { return textParts[0]; }
    }
    if (textParts.length > 1) {
      try { return JSON.parse(textParts.join('')); }
      catch { return textParts; }
    }
  }

  // Direct result shape
  if (result.data) return result.data;
  return result;
}

// ---------------- Convenience: quotes ----------------

export async function nseQuote(symbol) {
  return callNseMcpTool('nse_quote', { symbol }, 3000);
}

export async function nseCandles(symbol, timeframe = '15m', limit = 100) {
  return callNseMcpTool('nse_candles', { symbol, timeframe, limit }, 15000);
}

export async function nseMarketStatus() {
  return callNseMcpTool('nse_market_status', {}, 10000);
}

// ---------------- Circuit breaker ----------------

const _breaker = { fails: 0, openedAt: 0, backoffMs: 30_000 };
const BREAKER_FAILS = 5;

export function nseMcpHealth() {
  const now = Date.now();
  const isOpen = _breaker.fails >= BREAKER_FAILS && now - _breaker.openedAt < _breaker.backoffMs;
  return {
    available: !isOpen,
    fails: _breaker.fails,
    sessionActive: !!_sessionId,
    toolsCached: !!_tools,
    toolsCount: _tools?.length || 0,
  };
}

export function __resetNseMcpForTests() {
  _sessionId = null;
  _tools = null;
  _toolsAt = 0;
  _toolCache.clear();
  _breaker.fails = 0;
  _breaker.openedAt = 0;
}

// Note failure for circuit breaker
export function __noteNseMcpFail() {
  _breaker.fails++;
  if (_breaker.fails >= BREAKER_FAILS) {
    _breaker.openedAt = Date.now();
  }
}

// Note success resets the breaker
export function __noteNseMcpSuccess() {
  _breaker.fails = 0;
}

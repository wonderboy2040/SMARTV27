// ============================================================
// server/bots/freeLlmApiProvider.js — FreeLLMAPI decision provider
// ------------------------------------------------------------
// Bridges the local FreeLLMAPI router (127.0.0.1:31415) into the
// board AI confirm layer. Exposes the SAME interface as Jev:
//
//   createFreeLlmApiDecider(opts) -> decide(snap, prompt) -> decision
//
// where `decide` returns an object compatible with _toDecision():
//   { action, picked, probs, confidence, note, latencyMs, cached }
//
// This is ADDITIVE — Jev + FreeLLMAPI run side by side. The confirm
// layer stamps AGREE / CONFLICT / NEUTRAL from BOTH providers together.
// Existing MTF board / MTF auto-link / all other code untouched.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { freeLlmChat, FREELLMAPI_MODELS, freeLlmReachableCached, freeLlmKeyPresentCached } from '../ai/freellmapi.js';

const DECIDE_MODEL = FREELLMAPI_MODELS.smart;
const DECIDE_TIMEOUT_MS = 12_000;
const DECIDE_TEMPERATURE = 0.1;

function _buildDecideMessages(snap, prompt) {
  const contextLines = Array.isArray(snap?.contextLines) ? snap.contextLines : [];
  const side = snap?.proposed === 'enter_short' ? 'SHORT' : snap?.proposed === 'enter_long' ? 'LONG' : null;
  const criteria = prompt?.criteria || {};
  const instructions = prompt?.instructions || '';

  const system = `${instructions}

OUTPUT CONTRACT — STRICT JSON ONLY (no markdown, no prose, no fences):
{
  "choice": "enter_long" | "enter_short" | "wait",
  "probabilities": { "enter_long": 0.0-1.0, "enter_short": 0.0-1.0, "wait": 0.0-1.0 },
  "confidence": 0.0-1.0,
  "note": "one-line reason (max 80 chars)"
}

RULES:
- choice MUST be exactly one of: enter_long, enter_short, wait
- probabilities MUST sum to ~1.0
- confidence = how sure you are (0.0 = guess, 1.0 = certain)
- note = one short string explaining the pick
- If the signal side is ${side || 'unknown'} and you agree: choice = "${side || 'wait'}"
- If you disagree with the side: choice = the opposite
- If uncertain / bad risk-reward / event risk / counter-trend: choice = "wait"
- NEVER output anything except the JSON object`;

  const user = [
    ...contextLines,
    '',
    `--- Decision criteria ---`,
    `enter_long: ${criteria.enter_long || 'Take the LONG entry now'}`,
    `enter_short: ${criteria.enter_short || 'Take the SHORT entry now'}`,
    `wait: ${criteria.wait || 'Stand aside — conditions do not justify this entry'}`,
  ].filter(Boolean).join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

function _parseDecideResponse(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  const jsonStr = trimmed.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  let obj;
  try { obj = JSON.parse(jsonStr); }
  catch { return null; }

  if (!obj || typeof obj !== 'object') return null;
  const choice = String(obj.choice || '').toLowerCase();
  if (!['enter_long', 'enter_short', 'wait'].includes(choice)) return null;

  const probs = obj.probabilities && typeof obj.probabilities === 'object' ? obj.probabilities : {};
  const p = (k) => (Number.isFinite(Number(probs[k])) ? Math.max(0, Math.min(1, Number(probs[k]))) : null);
  return {
    choice,
    probabilities: { enter_long: p('enter_long'), enter_short: p('enter_short'), wait: p('wait') },
    confidence: Number.isFinite(Number(obj.confidence)) ? Math.max(0, Math.min(1, Number(obj.confidence))) : null,
    note: typeof obj.note === 'string' ? obj.note.slice(0, 80) : null,
  };
}

export function createFreeLlmApiDecider(opts = {}) {
  const model = opts.model || DECIDE_MODEL;
  const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || DECIDE_TIMEOUT_MS);
  let reachable = null;
  let reachableAt = 0;
  const REACHABLE_TTL_MS = 15_000;

  const cachePath = opts.cachePath || null;
  const cache = new Map();
  let cacheDirty = false;
  try {
    if (cachePath && typeof fs !== 'undefined' && fs.existsSync(cachePath)) {
      const lines = fs.readFileSync(cachePath, 'utf8').split('\n');
      for (const line of lines) {
        const s = line.trim();
        if (!s) continue;
        try {
          const r = JSON.parse(s);
          if (r?.key && r?.response) cache.set(r.key, r.response);
        } catch { /* skip corrupt line */ }
      }
    }
  } catch { /* cache is an optimization, not a dependency */ }

  const keyOf = (payload) => {
    const crypto = globalThis?.crypto;
    if (!crypto) return JSON.stringify(payload);
    return crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex').slice(0, 32);
  };

  function persistCache() {
    if (!cacheDirty || !cachePath) return;
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      const entries = Array.from(cache.entries()).slice(-20_000);
      const tmp = `${cachePath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, entries.map(([k, v]) => JSON.stringify({ key: k, response: v })).join('\n') + '\n');
      fs.renameSync(tmp, cachePath);
      cacheDirty = false;
    } catch { /* cache write failure must never break trading */ }
  }

  function isReachable() {
    if (reachable && Date.now() - reachableAt < REACHABLE_TTL_MS) return reachable;
    try { reachable = freeLlmReachableCached(); }
    catch { reachable = false; }
    reachableAt = Date.now();
    return reachable;
  }

  async function decide(snap, prompt) {
    const t0 = Date.now();
    if (!isReachable()) {
      return { action: 'wait', note: 'freellmapi_down', cached: false, latencyMs: Date.now() - t0 };
    }

    const messages = _buildDecideMessages(snap, prompt);
    const payloadKey = keyOf({ provider: 'freeLlmApi', model, messages, proposed: snap?.proposed });

    const cached = cache.get(payloadKey);
    if (cached) {
      return { ...cached, cached: true, latencyMs: Date.now() - t0 };
    }

    if (!freeLlmKeyPresentCached()) {
      return { action: 'wait', note: 'no_api_key', cached: false, latencyMs: Date.now() - t0 };
    }

    try {
      const out = await freeLlmChat({
        model,
        messages,
        temperature: DECIDE_TEMPERATURE,
        maxTokens: 256,
        timeoutMs,
      });

      const parsed = _parseDecideResponse(out.text);
      if (!parsed) {
        return { action: 'wait', note: 'no_answer', cached: false, latencyMs: Date.now() - t0 };
      }

      const decision = {
        action: parsed.choice,
        picked: parsed.choice === 'wait' ? null : parsed.choice,
        probs: parsed.probabilities,
        confidence: parsed.confidence,
        note: parsed.note || null,
        cached: false,
        latencyMs: Date.now() - t0,
      };

      cache.set(payloadKey, decision);
      cacheDirty = true;
      if (cache.size > 20_000) {
        const excess = cache.size - 20_000;
        const it = cache.keys();
        for (let i = 0; i < excess; i++) { const k = it.next().value; if (k !== undefined) cache.delete(k); }
      }
      return decision;
    } catch {
      return { action: 'wait', note: 'network_error', cached: false, latencyMs: Date.now() - t0 };
    }
  }

  decide.stats = () => ({
    calls: 0, cacheHits: cache.size, errors: 0, rejects: 0,
    latencies: [], breakerOpen: false, p50: null, p95: null,
    model, url: '127.0.0.1:31415', threshold: 0, name: 'freeLlmApi',
    queueWaits: 0, concurrency: 0,
  });

  decide.config = () => ({
    name: 'freeLlmApi', model, url: '127.0.0.1:31415',
    apiKey: freeLlmKeyPresentCached() ? '***' : '', timeoutMs,
  });

  decide.__cache = cache;
  decide.__persist = persistCache;
  return decide;
}

export function __resetFreeLlmApiForTests() {
  // no-op: reachable cache is internal; full reset via freellmapi's hook
}

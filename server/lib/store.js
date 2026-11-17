// ============================================================
// lib/store — tiny JSON file persistence for server state (was intraday/store)
// ------------------------------------------------------------
// Persists tracked signals, paper trades and the custom watchlist
// under server/data/ so a Render restart (or crash) does not wipe
// the day's track record / virtual positions. Writes are atomic
// (tmp file + rename) and failure-tolerant: a read-only filesystem
// degrades to in-memory-only operation instead of crashing the API.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// SMARTAI_DATA_DIR: dev/test isolation override (verify scripts point the
// server at a temp dir so dev-box journal/config state never leaks into a
// test run — and vice versa). Production leaves it unset → server/data/.
export const DATA_DIR = process.env.SMARTAI_DATA_DIR
  ? path.resolve(process.env.SMARTAI_DATA_DIR)
  : path.join(__dirname, '..', 'data');

let _dirReady = false;
function ensureDir() {
  if (_dirReady) return true;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    _dirReady = true;
  } catch {
    _dirReady = false;
  }
  return _dirReady;
}

// ------------------------------------------------------------
// v20.7.12 [H2-3] — THE 1Hz JOURNAL SYNC-PARSE FIX (the historical
// EVENT-LOOP FREEZE class). positionsStream's shared poller calls
// getPositionsWithPnl() every 1s while any SSE client is connected,
// and its first line is loadJournal() → loadJSON → readFileSync +
// JSON.parse of the FULL trading journal (500 entries + 90d closed
// positions ≈ 0.5–2MB). That sync parse ran EVERY SECOND on the hot
// path — exactly the "30s window worst lag 5.5s" contributor class.
// THE FIX: mtime+size checked cache (the same discipline proTraderAuto's
// journal got in v20.7.4). statSync is microseconds; the expensive
// read+parse runs ONLY when the file actually changed (saveJSON
// invalidates eagerly; external writes surface on the next stat —
// same visibility as before, TTL race nahi). Hits return a
// structuredClone so callers can keep mutating the loaded object
// (clone ≈ 5–10× cheaper than read+parse of the same payload).
// ------------------------------------------------------------
const _loadCache = new Map(); // cacheKey → { mtimeMs, size, value }
const _LOAD_CACHE_MAX = 48;
function _cacheKeyOf(filename, fallback) {
  try {
    const fb = (fallback && typeof fallback === 'object' && !Array.isArray(fallback))
      ? Object.keys(fallback).sort().join(',')
      : Array.isArray(fallback) ? '[]' : String(typeof fallback);
    return `${filename}|${fb}`;
  } catch { return String(filename); }
}

export function loadJSON(filename, fallback) {
  try {
    const p = path.join(DATA_DIR, filename);
    const key = _cacheKeyOf(filename, fallback);
    let st = null;
    try { st = fs.statSync(p); } catch { st = null; }
    if (!st) {
      // file absent → fallback (do NOT cache: file may appear later)
      _loadCache.delete(key);
      return structuredClone(fallback);
    }
    const hit = _loadCache.get(key);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      return structuredClone(hit.value); // v20.7.4 lesson: mtime+SIZE dono
    }
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    // Merge over fallback so newly-added fields get sane defaults
    // when reading a file written by an older build.
    let value = parsed;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      && fallback && typeof fallback === 'object' && !Array.isArray(fallback)) {
      const merged = { ...structuredClone(fallback), ...parsed };
      // Hardening: a state file containing explicit `null` (manual edit /
      // older-bug artifact) would override the fallback array and crash
      // every `.filter()` consumer in that module. Normalize arrays back.
      for (const k of Object.keys(fallback)) {
        if (Array.isArray(fallback[k]) && !Array.isArray(merged[k])) merged[k] = structuredClone(fallback[k]);
      }
      value = merged;
    }
    // bounded cache (state files are few, but never grow unbounded)
    if (_loadCache.size >= _LOAD_CACHE_MAX) {
      const oldest = _loadCache.keys().next().value;
      if (oldest !== undefined) _loadCache.delete(oldest);
    }
    _loadCache.set(key, { mtimeMs: st.mtimeMs, size: st.size, value });
    return structuredClone(value);
  } catch {
    return structuredClone(fallback);
  }
}

// v21.37.0 [PERSISTENCE RETRY] — the classic silent state-loss vector: a
// TRANSIENT I/O failure (Windows Defender real-time scanning locking the
// fresh .tmp file, busy-disk I/O spikes during the 290-file test run) made
// the one-shot write throw → `catch { return false }` → the next loadJSON
// returned the FALLBACK, so the just-saved state (trading config kill-switch,
// journal, tamper-evident ledger, outcome dataset) was lost while callers
// that ignore the return value believed it had been written. Bounded retry
// absorbs the transient class; the fast path is byte-for-byte the same
// write as before, and a genuinely read-only FS still degrades to the
// honest `false` (memory-only mode) after the last attempt.
const _SAVE_ATTEMPTS = 3;
const _SAVE_BACKOFF_MS = [0, 25, 50]; // yield before attempts 2 and 3
function _yieldMs(ms) {
  // Block the thread for `ms` without busy-spinning: Atomics.wait on a
  // 1-slot SAB. Reached only on the FAILED-write path, so the hot path
  // never touches it.
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function saveJSON(filename, data) {
  let tmp = null; // the attempt's tmp path — for orphan cleanup on failure
  for (let attempt = 0; attempt < _SAVE_ATTEMPTS; attempt++) {
    try {
      if (!ensureDir()) return false;
      const p = path.join(DATA_DIR, filename);
      // v7.0.2: unique tmp name (pid + ms + attempt). A second writer
      // process using the SAME shared `${p}.tmp` path could interleave
      // write+rename and corrupt the file; unique names keep the
      // write+rename atomic per writer.
      tmp = `${p}.${process.pid}.${Date.now()}.${attempt}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
      fs.renameSync(tmp, p);
      tmp = null; // renamed into place — nothing to clean up
      // v20.7.12 [H2-3]: invalidate every cached variant of this file (the
      // next load re-reads — caller-mutated objects are never cached).
      for (const k of _loadCache.keys()) {
        if (k.startsWith(`${filename}|`)) _loadCache.delete(k);
      }
      return true;
    } catch {
      if (attempt === _SAVE_ATTEMPTS - 1) {
        // Non-fatal after the last attempt: best-effort persistence
        // (read-only FS ⇒ memory-only mode). Callers that ignore the
        // return value keep the in-memory value.
        return false;
      }
      // Clean up the orphaned .tmp of THIS attempt (best-effort — a failed
      // write may not have created it), then retry after a short yield.
      if (tmp) { try { fs.unlinkSync(tmp); } catch { /* FS gone entirely */ } tmp = null; }
      _yieldMs(_SAVE_BACKOFF_MS[attempt + 1]);
    }
  }
  return false; // unreachable — the loop always returns
}

/** v20.7.12 test hook — drop the load cache (hermetic suites). */
export function __clearLoadCacheForTests() { _loadCache.clear(); }

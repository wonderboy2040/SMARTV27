// ============================================================
// test/freellmapiJsonCacheV21410.test.ts — v21.41.0 ANALYSIS OPTIMIZATION
// ------------------------------------------------------------
// Identical strict-JSON prompts arrive in bursts (board scan + expert
// picks + deep recheck). Locks:
//   • ONE upstream call per unique prompt within the short TTL;
//   • concurrent identical prompts share a single-flight promise;
//   • different prompts are never coalesced;
//   • a prose answer falls back ONCE to auto:reliable, then stays honest;
//   • TTL=0 disables the cache; status exposes cache proof (no secrets).
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const URL_BASE = 'http://127.0.0.1:59998';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function chatOk(content: string, model = 'auto:smart'): Response {
  return jsonResponse({
    model,
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { total_tokens: 10 },
  });
}

async function loadModule() {
  vi.resetModules();
  const mod = await import('../server/ai/freellmapi.js');
  mod.__resetFreeLlmForTests();
  return mod;
}

describe('v21.41.0 freellmapi strict-JSON cache', () => {
  beforeEach(() => {
    process.env.FREELLMAPI_URL = URL_BASE;
    process.env.FREELLMAPI_API_KEY = 'test-unified-key';
    delete process.env.FREELLMAPI_JSON_CACHE_TTL_MS;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.FREELLMAPI_URL;
    delete process.env.FREELLMAPI_API_KEY;
    delete process.env.FREELLMAPI_JSON_CACHE_TTL_MS;
  });

  function stubChat(handler: (body: any, call: number) => Response) {
    let calls = 0;
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: any, opts: any = {}) => {
      const u = String(url);
      if (u.endsWith('/api/ping')) return jsonResponse({ ok: true });
      if (u.includes('/v1/models')) return jsonResponse({ data: [{ id: 'auto:smart' }, { id: 'auto:reliable' }] });
      if (u.includes('/v1/chat/completions')) {
        const body = JSON.parse(String(opts.body));
        bodies.push(body);
        calls += 1;
        return handler(body, calls);
      }
      throw new Error(`unexpected fetch: ${u}`);
    }));
    return { bodies, calls: () => calls };
  }

  it('serves an identical prompt from cache inside the TTL (one upstream call)', async () => {
    const stub = stubChat(() => chatOk('{"verdict":"BUY","score":88}'));
    const mod = await loadModule();
    const first = await mod.freeLlmJson('Analyse BTC now', { model: 'auto:fast' });
    const second = await mod.freeLlmJson('Analyse BTC now', { model: 'auto:fast' });
    expect(first.json).toEqual({ verdict: 'BUY', score: 88 });
    expect(second.json).toEqual(first.json);
    expect(second.cached).toBe(true);
    expect(second.cacheAgeMs).toBeGreaterThanOrEqual(0);
    expect(stub.calls()).toBe(1);
    expect(mod.freeLlmStatus().jsonCache.hits).toBe(1);
  });

  it('never coalesces different prompts or different models', async () => {
    const stub = stubChat(() => chatOk('{"ok":true}'));
    const mod = await loadModule();
    await mod.freeLlmJson('Analyse BTC now', { model: 'auto:fast' });
    await mod.freeLlmJson('Analyse ETH now', { model: 'auto:fast' });
    await mod.freeLlmJson('Analyse BTC now', { model: 'auto:smart' });
    expect(stub.calls()).toBe(3);
  });

  it('single-flight: concurrent identical prompts share one upstream call', async () => {
    const stub = stubChat(() => chatOk('{"ok":true}'));
    const mod = await loadModule();
    const [a, b, c] = await Promise.all([
      mod.freeLlmJson('Concurrent analysis', { model: 'auto:fast' }),
      mod.freeLlmJson('Concurrent analysis', { model: 'auto:fast' }),
      mod.freeLlmJson('Concurrent analysis', { model: 'auto:fast' }),
    ]);
    expect(a.json).toEqual({ ok: true });
    expect(b.json).toEqual({ ok: true });
    expect(c.json).toEqual({ ok: true });
    expect(stub.calls()).toBe(1);
    expect(mod.freeLlmStatus().jsonCache.inflightHits).toBe(2);
  });

  it('falls back ONCE to auto:reliable when the routed model answers prose', async () => {
    const stub = stubChat((body) => (
      body.model === 'auto:reliable' ? chatOk('{"salvaged":true}', 'auto:reliable') : chatOk('I think it might go up.')
    ));
    const mod = await loadModule();
    const out = await mod.freeLlmJson('Analyse SOL now', { model: 'auto:fast' });
    expect(out.json).toEqual({ salvaged: true });
    expect(out.model).toBe('auto:reliable');
    expect(stub.calls()).toBe(2);
    expect(stub.bodies[1].model).toBe('auto:reliable');
    expect(stub.bodies[1].response_format).toEqual({ type: 'json_object' });
    expect(mod.freeLlmStatus().jsonCache.fallbacks).toBe(1);
  });

  it('stays honest when both models answer prose (json = null)', async () => {
    const stub = stubChat(() => chatOk('I cannot answer that.'));
    const mod = await loadModule();
    const out = await mod.freeLlmJson('Analyse XRP now', { model: 'auto:fast' });
    expect(out.json).toBeNull();
    expect(stub.calls()).toBe(2); // primary + one fallback
    expect(mod.freeLlmStatus().jsonCache.entries).toBe(0); // nulls are never cached
  });

  it('does not retry auto:reliable against itself', async () => {
    const stub = stubChat(() => chatOk('Still prose.'));
    const mod = await loadModule();
    const out = await mod.freeLlmJson('Analyse ADA now', { model: 'auto:reliable' });
    expect(out.json).toBeNull();
    expect(stub.calls()).toBe(1);
  });

  it('TTL=0 disables both cache and single-flight', async () => {
    process.env.FREELLMAPI_JSON_CACHE_TTL_MS = '0';
    const stub = stubChat(() => chatOk('{"ok":true}'));
    const mod = await loadModule();
    await mod.freeLlmJson('No cache prompt', { model: 'auto:fast' });
    await mod.freeLlmJson('No cache prompt', { model: 'auto:fast' });
    expect(stub.calls()).toBe(2);
    const status = mod.freeLlmStatus().jsonCache;
    expect(status.ttlMs).toBe(0);
    expect(status.entries).toBe(0);
  });
});

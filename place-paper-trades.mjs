// place-paper-trades.mjs — v21.37.1 unlimited daily cap
const http = require('node:http');
const BASE = 'http://localhost:8080';
const cookies = new Map();

function api(path, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + path);
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    const c = cookies.get('localhost'); if (c) headers['Cookie'] = c;
    const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: opts.method || 'GET', headers }, (res) => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        const sc = res.headers['set-cookie'];
        if (sc) cookies.set('localhost', sc.map(c => c.split(';')[0]).join('; '));
        let data; try { data = JSON.parse(text); } catch { data = text; }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function summary(r, label) {
  const ok = r.data?.ok;
  const err = r.data?.error || r.data?.reason;
  console.log(`${label}: HTTP ${r.status} ${ok ? 'OK' : 'BLOCKED'} ${err ? '— ' + err.slice(0, 120) : ''}`);
  return r.data;
}

(async () => {
  const login = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ pin: 'SmartAI2026' }) });
  console.log('Login:', login.status, login.data?.sessionToken?.slice(0,8) + '...');

  // 1) BTC CRYPTO ACTION 65
  const r1 = await api('/api/ai/execute', { method: 'POST', body: JSON.stringify({ symbol: 'BTC', side: 'SHORT', mode: 'paper' }) });
  const d1 = summary(r1, 'BTC SHORT CRYPTO');

  // 2) SOL FUTURES ACTION 67
  const r2 = await api('/api/ai/futures/execute', { method: 'POST', body: JSON.stringify({ symbol: 'SOL', side: 'SHORT', mode: 'paper' }) });
  const d2 = summary(r2, 'SOL SHORT FUTURES');

  // 3) SONA INDIA (WATCH but conf 77 — try)
  const r3 = await api('/api/ai/execute', { method: 'POST', body: JSON.stringify({ symbol: 'SONA', side: 'LONG', market: 'INDIA', mode: 'paper' }) });
  const d3 = summary(r3, 'SONA LONG INDIA');

  // 4) FIL CRYPTO WATCH — try anyway with unlimited cap
  const r4 = await api('/api/ai/execute', { method: 'POST', body: JSON.stringify({ symbol: 'FIL', side: 'SHORT', mode: 'paper' }) });
  const d4 = summary(r4, 'FIL SHORT CRYPTO');

  // 5) JCT FUTURES — previously traded, retry
  const r5 = await api('/api/ai/futures/execute', { method: 'POST', body: JSON.stringify({ symbol: 'JCT', side: 'SHORT', mode: 'paper' }) });
  const d5 = summary(r5, 'JCT SHORT FUTURES');

  console.log('\n=== MONITOR (15s) ===');
  await new Promise(r => setTimeout(r, 15000));
  const pos = await api('/api/ai/positions');
  const open = (pos.data?.positions || []).filter(p => p.status === 'OPEN');
  console.log(`Open positions: ${open.length}`);
  for (const t of open) {
    console.log(`  ${t.symbol} ${t.side} | entry=${t.entryPrice} | sl=${t.sl} | t1=${t.t1} | pnl=${t.pnl ?? '—'}`);
  }
  if (!open.length) console.log('  (none open)');
})();

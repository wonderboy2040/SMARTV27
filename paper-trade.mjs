// paper-trade.mjs — place + monitor a paper trade on the first actionable signal
import http from 'node:http';

const BASE = 'http://localhost:8080';
const COOKIE_JAR = new Map();

function request(opts, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        const setCookie = res.headers['set-cookie'];
        if (setCookie) COOKIE_JAR.set('localhost', setCookie.map(c => c.split(';')[0]).join('; '));
        let data; try { data = JSON.parse(text); } catch { data = text; }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function api(path, opts = {}) {
  const url = new URL(BASE + path);
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const jarCookie = COOKIE_JAR.get('localhost');
  if (jarCookie) headers['Cookie'] = jarCookie;
  return request({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: opts.method || 'GET', headers }, opts.body);
}

function pickMarket(markets) {
  // Try markets in order: CRYPTO, FUTURES, GLOBALFUTURES, METALS, INDIA
  const priority = ['CRYPTO', 'FUTURES', 'METALS', 'GLOBALFUTURES', 'INDIA'];
  for (const m of priority) {
    if (markets.includes(m)) return m;
  }
  return markets[0];
}

async function main() {
  // 1) Login
  const loginRes = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ pin: 'SmartAI2026' }) });
  if (loginRes.status !== 200 || !loginRes.data?.sessionToken) {
    console.error('LOGIN FAILED:', loginRes.data);
    process.exit(1);
  }
  console.log(`LOGIN OK`);

  // 2) Get available markets
  const marketsRes = await api('/api/ai/markets');
  const markets = marketsRes.data?.markets || ['CRYPTO', 'FUTURES', 'METALS', 'INDIA'];
  console.log(`Available markets: ${markets.join(', ')}`);

  // 3) Scan each market for actionable signals (grade=STRONG or ACTION)
  let bestSignal = null;
  let bestMarket = null;

  for (const m of markets) {
    const sigRes = await api(`/api/ai/signals?market=${m}&limit=10`);
    const signals = sigRes.data?.signals || [];
    console.log(`\n${m}: ${signals.length} signals`);
    for (const s of signals) {
      const grade = (s.grade || '').toUpperCase();
      const conf = Number(s.confidence || s.score || 0);
      console.log(`  ${s.symbol} | ${s.side} | grade=${grade} | conf=${conf}`);
      if ((grade === 'STRONG' || grade === 'ACTION' || grade === 'ELITE') && conf >= 60 && !bestSignal) {
        bestSignal = s;
        bestMarket = m;
      }
    }
  }

  if (!bestSignal) {
    console.log('\nNo actionable signals (STRONG/ACTION/ELITE with conf>=60) found across all markets.');
    console.log('Trying MTF dual board endpoint...');
    // Try MTF dual board for METALS as fallback
    const boardRes = await api(`/api/ai/mtf-dual/board?market=METALS&mode=INTRADAY`);
    const rows = boardRes.data?.rows || [];
    console.log(`MTF Dual Board: ${rows.length} rows`);
    for (const r of rows) {
      console.log(`  ${r.symbol} | ${r.side} | score=${r.score} | grade=${r.grade}`);
      if ((r.grade === 'STRONG' || r.grade === 'ACTION' || r.grade === 'ELITE') && (r.score || 0) >= 65 && !bestSignal) {
        bestSignal = r;
        bestMarket = 'METALS';
      }
    }
  }

  if (!bestSignal) {
    console.log('\nNo tradeable signals found. Engine is correctly filtering low-quality setups.');
    process.exit(0);
  }

  console.log(`\n*** SELECTED: ${bestSignal.symbol} ${bestSignal.side} on ${bestMarket} ***`);

  // 4) Open paper trade via board endpoint
  console.log('\nOpening paper trade...');
  const paperRes = await api('/api/ai/mtf-dual/paper', {
    method: 'POST',
    body: JSON.stringify({
      symbol: bestSignal.symbol,
      market: bestMarket,
      mode: 'INTRADAY',
      holdMin: 45,
    }),
  });

  console.log(`PAPER TRADE (HTTP ${paperRes.status}):`);
  console.log(JSON.stringify(paperRes.data, null, 2).slice(0, 3000));

  if (paperRes.data?.ok && paperRes.data?.paperId) {
    console.log(`\nPAPER TRADE OPENED: ${paperRes.data.paperId}`);
    // 5) Monitor — poll paper summary
    console.log('\nMonitoring for 30s...');
    for (let i = 1; i <= 6; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const summary = await api('/api/ai/paper/summary');
      const trades = summary.data?.trades || [];
      const active = trades.filter(t => t.status === 'OPEN');
      console.log(`  [${i*5}s] ${active.length} open paper trades`);
      for (const t of active) {
        console.log(`    ${t.symbol} ${t.side} | entry=${t.entry} | sl=${t.sl} | t1=${t.t1} | t2=${t.t2} | pnl=${t.pnlPct ?? t.pnl ?? '—'}`);
      }
    }
    console.log('\nMonitoring complete.');
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
